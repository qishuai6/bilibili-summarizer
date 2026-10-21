// 后台：① 代理跨域 fetch（MV3 里 content script 跨域受 CORS 限制，SW 不受限）
//       ② AI 总结（OpenAI 兼容接口，流式输出，长字幕自动分段汇总）
//       ③ 总结分三档长度：brief（一段话）/ standard（要点式）/ detailed（结构化笔记）

const CHUNK_LIMIT = 20000; // 单次直接总结的字幕字符上限，超出走「分段小结→汇总」

const LEN_LABEL = { brief: '50 字以内', standard: '100 字以内', detailed: '150 字以内' };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'bsz-fetch') {
    fetch(msg.url, { credentials: msg.credentials ? 'include' : 'omit' })
      .then(r => r.text().then(t => sendResponse({ ok: r.ok, status: r.status, text: t })))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'bsz-ai') return;
  port.onMessage.addListener(async msg => {
    if (msg.type !== 'summarize') return;
    try {
      await doSummarize(msg.config, msg.subtitleText, m => port.postMessage(m));
      port.postMessage({ done: true });
    } catch (e) {
      port.postMessage({ error: (e && e.message) || String(e) });
    }
  });
});

async function chatStream(config, messages, onDelta) {
  const base = (config.apiBase || '').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.apiKey
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      temperature: 0.3
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) onDelta(delta);
      } catch (_) { /* 忽略心跳等非 JSON 行 */ }
    }
  }
}

async function doSummarize(config, subtitleText, emit) {
  if (!config.apiKey) throw new Error('还没有填 API Key，先到「设置」里填一下');
  const len = config.summaryLength || 'standard';

  if (subtitleText.length <= CHUNK_LIMIT) {
    emit({ status: '正在阅读字幕…' });
    await chatStream(config, [{ role: 'user', content: buildPrompt(subtitleText, len) }], d => emit({ delta: d }));
    return;
  }

  // 长视频：分段小结，再汇总成稿
  const chunks = splitChunks(subtitleText, CHUNK_LIMIT);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    emit({ status: `视频较长，分段小结 ${i + 1}/${chunks.length}…` });
    let partial = '';
    await chatStream(
      config,
      [{ role: 'user', content: `以下是长视频字幕的第 ${i + 1}/${chunks.length} 段。请用 ${LEN_LABEL[len]}客观小结这一段：讲了什么、给出哪些数据、案例和结论，保留具体数字和人名。直接输出内容。` + chunks[i] }],
      d => { partial += d; }
    );
    partials.push(partial);
  }
  emit({ status: '汇总成稿…' });
  const merged = partials.map((p, i) => `【第 ${i + 1} 段小结】\n${p}`).join('\n\n');
  await chatStream(
    config,
    [{ role: 'user', content: buildPrompt(merged, len, true) }],
    d => emit({ delta: d })
  );
}

function splitChunks(text, limit) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    let end = i + limit;
    if (end < text.length) {
      const brk = text.lastIndexOf('\n', end);
      if (brk > i + limit * 0.5) end = brk; // 在段落边界断开
    }
    chunks.push(text.slice(i, end));
  }
  return chunks;
}

const COMMON_RULES = `要求：
- 只依据给出的内容，不要编造里面没有的信息
- 语音转写的错别字自行纠正，引用时保持原意
- 要点必须带上具体的数据、案例、人名或方法名，不许只写「讲了某种方法」这类空话
- 直接输出 Markdown，不要寒暄`;

function buildPrompt(content, len, fromPartials) {
  const source = fromPartials
    ? '以下是这支长视频各段的分段小结（信息比字幕原文少，基于它们总结）：\n\n'
    : '【视频字幕如下】\n';

  if (len === 'brief') {
    return `你是专业的视频内容分析师。用户只想花 10 秒钟了解这支视频。${fromPartials ? '以下是这支长视频各段的分段小结，' : ''}请基于内容输出一段 80~150 字的中文总结：直接讲清核心观点和结论、值不值得看完，至少保留一个具体数据或案例。不分行、不用标题、直接输出正文。\n\n${source}${content}`;
  }

  if (len === 'detailed') {
    return `你是专业的视频内容分析师。用户想把这支视频吃透，请基于内容输出一份详细的中文结构化笔记（Markdown 格式）：

## 一句话总结
40 字以内，直接给判断

## 内容脉络
按讲述顺序分 3~6 节，每节一个小标题 + 2~3 行要点，保留视频的推进逻辑

## 关键数据与案例
列出内容里的具体数字、案例、人名和对应结论，用列表

## 值得回看的片段
2~4 个，格式「[约 mm:ss] 为什么值得看」；拿不准时间可省略这节

## 金句摘录
1~3 句原话，注明大致时间

${COMMON_RULES}

${source}${content}`;
  }

  // standard（默认）
  return `你是专业的视频内容分析师。用户没时间看完整个视频，请基于内容写一份让他 3 分钟了解全貌的中文总结，Markdown 格式，结构如下：

## 一句话总结
这支视频讲了什么 + 值不值得看完，40 字以内，直接给判断

## 核心内容
3~6 个要点，每点 1~2 行，保留视频里的关键数据、案例、人名和结论

## 值得回看的片段
1~3 个，格式为「[约 mm:ss] 为什么值得看」；如果拿不准时间就省略这一节

## 金句摘录
0~3 句视频原话，注明大致时间；没有就不写这一节

${COMMON_RULES}

${source}${content}`;
}
