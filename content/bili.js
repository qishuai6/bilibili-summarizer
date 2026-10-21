// B站视频总结助手 · 内容脚本
// 职责：悬浮按钮 + 侧边面板 UI、字幕提取（多级回退）、AI 总结流式渲染、总结长度选择、设置管理
// UI：iOS 液态玻璃风格（毛玻璃材质 / 分段控件 / 跟随系统深色模式）
(() => {
  if (window.__BSZ_LOADED__) return;
  window.__BSZ_LOADED__ = true;

  // ---------------- 常量与状态 ----------------
  const PRESETS = {
    zhipu:    { label: '智谱 GLM（免费模型可用）', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
    kimi:     { label: 'Kimi（月之暗面）', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    custom:   { label: '自定义（OpenAI 兼容接口）', base: '', model: '' }
  };
  const LENGTHS = [
    { key: 'brief', label: '简短' },
    { key: 'standard', label: '标准' },
    { key: 'detailed', label: '详细' }
  ];
  const DEFAULTS = { preset: 'zhipu', apiBase: PRESETS.zhipu.base, apiKey: '', model: PRESETS.zhipu.model, summaryLength: 'standard' };

  const state = {
    info: null,        // { bvid, aid, title, duration, page, pages, cid }
    segs: [],          // 字幕段落 [{ start, text }]
    transcript: '',    // 喂给 AI / 复制用的全文
    lanDoc: '',
    summaryRaw: '',
    loading: false,
    summarizing: false
  };
  let cfg = { ...DEFAULTS };
  let panelOpen = false;
  let aiPort = null;

  // ---------------- 工具函数 ----------------
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  // 轻量 Markdown 渲染（标题/列表/引用/加粗/行内代码/链接）
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }
  function mdRender(src) {
    const lines = escapeHtml(src).split(/\r?\n/);
    let html = '', list = '';
    const closeList = () => { if (list) { html += '</' + list + '>'; list = ''; } };
    let quote = false;
    const closeQuote = () => { if (quote) { html += '</blockquote>'; quote = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^([-*]|\d+\.)\s+/.test(line)) {
        closeQuote();
        const ordered = /^\d+\./.test(line);
        if (list !== (ordered ? 'ol' : 'ul')) { closeList(); list = ordered ? 'ol' : 'ul'; html += '<' + list + '>'; }
        html += '<li>' + inline(line.replace(/^([-*]|\d+\.)\s+/, '')) + '</li>';
        continue;
      }
      closeList();
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeQuote(); html += '<h' + Math.min(h[1].length + 1, 4) + '>' + inline(h[2]) + '</h' + Math.min(h[1].length + 1, 4) + '>'; continue; }
      if (/^>\s?/.test(line)) { if (!quote) { quote = true; html += '<blockquote>'; } html += '<p>' + inline(line.replace(/^>\s?/, '')) + '</p>'; continue; }
      closeQuote();
      if (!line) continue;
      html += '<p>' + inline(line) + '</p>';
    }
    closeList(); closeQuote();
    return html;
  }

  // ---------------- 通信：主世界脚本 / 后台 ----------------
  let injectSeq = 0;
  function callInject(cmd, payload) {
    return new Promise((resolve, reject) => {
      const id = ++injectSeq;
      const on = e => {
        const d = e.data;
        if (!d || d.dir !== 'bsz-out' || d.id !== id) return;
        window.removeEventListener('message', on);
        d.error ? reject(new Error(d.error)) : resolve(d.result);
      };
      window.addEventListener('message', on);
      window.postMessage({ dir: 'bsz-in', id, cmd, payload }, location.origin);
      setTimeout(() => { window.removeEventListener('message', on); reject(new Error('页面通信超时')); }, 15000);
    });
  }
  function bgFetch(url, credentials) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bsz-fetch', url, credentials: !!credentials }, r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r) return reject(new Error('后台无响应'));
        r.error ? reject(new Error(r.error)) : resolve(r);
      });
    });
  }
  const bgJson = async (url, credentials) => JSON.parse((await bgFetch(url, credentials)).text);
  const injectJson = async url => await (await callInject('fetch', { url })).text;

  // ---------------- 字幕获取 ----------------
  const pageOf = () => {
    const p = parseInt(new URLSearchParams(location.search).get('p'), 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  async function getVideoInfo() {
    try { return await callInject('video-info'); } catch (_) { /* 回退走后台接口 */ }
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!m) throw new Error('没识别到视频 BV 号');
    const j = await bgJson('https://api.bilibili.com/x/web-interface/view?bvid=' + m[1], true);
    if (j.code !== 0) throw new Error('拿视频信息失败：' + (j.message || j.code));
    const d = j.data, p = pageOf();
    const page = (d.pages || []).find(pg => pg.page === p);
    return {
      bvid: d.bvid, aid: d.aid, title: d.title,
      duration: (page && page.duration) || d.duration,
      page: p, pages: (d.pages || []).length || 1,
      cid: (page && page.cid) || d.cid
    };
  }

  async function getSubtitleList(info) {
    const api = 'https://api.bilibili.com/x/player/wbi/v2?bvid=' + info.bvid + '&cid=' + info.cid;
    let subs = [];
    try {
      const j = await bgJson(api, true);
      subs = (j && j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    } catch (_) { /* 降级到页面身份 */ }
    if (!subs.length) {
      try {
        const j = JSON.parse(await injectJson(api));
        subs = (j && j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
      } catch (_) { /* 两路都拿不到 */ }
    }
    return subs;
  }

  function pickSubtitle(subs) {
    if (!subs.length) return null;
    const pri = ['ai-zh', 'zh-Hans', 'zh-CN', 'zh'];
    for (const lan of pri) {
      const hit = subs.find(s => s.lan === lan);
      if (hit) return hit;
    }
    return subs[0];
  }

  async function fetchSubtitleBody(sub) {
    let url = sub.subtitle_url || '';
    if (url.startsWith('//')) url = 'https:' + url;
    if (!url) throw new Error('字幕地址为空');
    let text;
    try { text = (await bgFetch(url, false)).text; }
    catch (_) { text = await injectJson(url); }
    const body = (JSON.parse(text).body) || [];
    if (!body.length) throw new Error('字幕文件是空的');
    return body;
  }

  // 逐条字幕合并成段落：45 秒或 90 字一段，段首带时间戳
  function buildSegments(body) {
    const segs = [];
    let cur = null;
    for (const line of body) {
      if (!line || !line.content) continue;
      if (!cur) cur = { start: line.from, text: '' };
      cur.text += line.content;
      if (line.to - cur.start > 45 || cur.text.length > 90) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    return segs;
  }

  // ---------------- UI ----------------
  const CSS = [
    ':host{',
    '  --accent:#007aff; --accent-soft:rgba(0,122,255,.12);',
    '  --label:#1d1d1f; --label2:rgba(60,60,67,.62); --label3:rgba(60,60,67,.35);',
    '  --glass:rgba(255,255,255,.68); --glass-border:rgba(255,255,255,.65);',
    '  --fill:rgba(120,120,128,.12); --fill-strong:rgba(120,120,128,.20);',
    '  --thumb:rgba(255,255,255,.96);',
    '  --sep:rgba(60,60,67,.14);',
    '  --code-bg:rgba(120,120,128,.14);',
    '  --err:#d70015; --err-bg:rgba(255,59,48,.10);',
    '  --shadow-panel:0 24px 70px rgba(0,0,0,.24), 0 2px 10px rgba(0,0,0,.08);',
    '  --inset-hi:inset 0 1px 0 rgba(255,255,255,.85), inset 0 0 0 .5px rgba(255,255,255,.35);',
    '}',
    '@media (prefers-color-scheme:dark){:host{',
    '  --accent:#0a84ff; --accent-soft:rgba(10,132,255,.24);',
    '  --label:#f5f5f7; --label2:rgba(235,235,245,.72); --label3:rgba(235,235,245,.45);',
    '  --glass:rgba(28,28,32,.84); --glass-border:rgba(255,255,255,.16);',
    '  --fill:rgba(120,120,128,.30); --fill-strong:rgba(120,120,128,.42);',
    '  --thumb:rgba(125,125,132,.92);',
    '  --sep:rgba(235,235,245,.16);',
    '  --code-bg:rgba(120,120,128,.32);',
    '  --err:#ff453a; --err-bg:rgba(255,69,58,.18);',
    '  --shadow-panel:0 24px 70px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35);',
    '  --inset-hi:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 .5px rgba(255,255,255,.08);',
    '}}',
    "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased}",
    // —— 悬浮按钮：玻璃胶囊
    '.bsz-fab{position:fixed;right:14px;top:46%;z-index:2147483000;',
    '  background:var(--glass);backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);',
    '  border:.5px solid var(--glass-border);border-radius:999px;padding:11px 18px;',
    '  font-size:13.5px;font-weight:600;letter-spacing:.2px;color:var(--label);',
    '  box-shadow:0 10px 34px rgba(0,0,0,.18),var(--inset-hi);cursor:pointer;user-select:none;',
    '  transition:transform .18s cubic-bezier(.3,.7,.3,1)}',
    '.bsz-fab:active{transform:scale(.94)}',
    // —— 面板：液态玻璃卡片
    '.bsz-panel{position:fixed;right:16px;top:60px;bottom:24px;width:404px;z-index:2147483000;',
    '  background:var(--glass);backdrop-filter:blur(44px) saturate(190%);-webkit-backdrop-filter:blur(44px) saturate(190%);',
    '  border-radius:28px;border:.5px solid var(--glass-border);',
    '  box-shadow:var(--shadow-panel),var(--inset-hi);',
    '  display:flex;flex-direction:column;overflow:hidden;color:var(--label)}',
    // —— 头部
    '.bsz-head{display:flex;align-items:center;gap:8px;padding:16px 18px 10px}',
    '.bsz-logo{color:var(--accent);font-weight:700;font-size:15px}',
    '.bsz-head-title{font-size:15px;font-weight:700;letter-spacing:.2px;flex:1}',
    '.bsz-head-btns{display:flex;gap:6px}',
    '.bsz-head-btns span{width:24px;height:24px;border-radius:50%;background:var(--fill);color:var(--label2);',
    '  font-size:13px;line-height:24px;text-align:center;cursor:pointer;transition:background .15s}',
    '.bsz-head-btns span:hover{background:var(--fill-strong)}',
    '.bsz-vtitle{padding:0 18px 12px;font-size:12.5px;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // —— 分段控件（iOS segmented control）
    '.bsz-seg{position:relative;display:flex;background:var(--fill);border-radius:11px;padding:2px}',
    '.bsz-seg-thumb{position:absolute;top:2px;bottom:2px;left:2px;width:calc((100% - 4px)/3);',
    '  background:var(--thumb);border-radius:9px;',
    '  box-shadow:0 3px 8px rgba(0,0,0,.12),0 1px 1px rgba(0,0,0,.06);',
    '  transition:transform .28s cubic-bezier(.3,.7,.3,1)}',
    '.bsz-seg-item{flex:1;position:relative;z-index:1;text-align:center;padding:6.5px 0;',
    '  font-size:13px;font-weight:600;color:var(--label2);cursor:pointer;user-select:none;transition:color .2s}',
    '.bsz-seg-item.bsz-active{color:var(--label)}',
    '.bsz-tabs{margin:0 18px 12px}',
    // —— 主体
    '.bsz-body{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.bsz-pane{flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 18px 16px}',
    '.bsz-pane-top{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
    '.bsz-len{flex:1;min-width:170px}',
    '.bsz-len .bsz-seg-item{padding:5px 0;font-size:12px}',
    '.bsz-meta{font-size:12px;color:var(--label3);flex:1;min-width:60px}',
    '.bsz-status{font-size:12px;color:var(--label3);flex:1}',
    '.bsz-scroll{flex:1;min-height:0;overflow-y:auto;font-size:13px;line-height:1.75;color:var(--label);padding-right:4px}',
    '.bsz-scroll::-webkit-scrollbar{width:5px}',
    '.bsz-scroll::-webkit-scrollbar-thumb{background:var(--fill-strong);border-radius:3px}',
    '.bsz-scroll::-webkit-scrollbar-track{background:transparent}',
    // —— 脚本时间戳
    '.bsz-line{margin-bottom:8px}',
    '.bsz-t{color:var(--accent);cursor:pointer;font-size:12px;font-weight:600;margin-right:6px;font-variant-numeric:tabular-nums}',
    // —— 按钮
    '.bsz-btn{background:var(--accent-soft);border:none;color:var(--accent);font-size:12.5px;font-weight:600;',
    '  border-radius:9px;padding:5px 12px;cursor:pointer;transition:transform .15s}',
    '.bsz-btn-primary{background:var(--accent);border:none;color:#fff;padding:7px 16px;font-size:13px;font-weight:600;',
    '  border-radius:11px;cursor:pointer;box-shadow:0 4px 16px rgba(0,122,255,.30);transition:transform .15s}',
    '.bsz-btn:active,.bsz-btn-primary:active{transform:scale(.94)}',
    '.bsz-btn[disabled],.bsz-btn-primary[disabled]{opacity:.4;cursor:not-allowed}',
    // —— 空态 / 错误
    '.bsz-empty{color:var(--label3);font-size:13px;text-align:center;padding:40px 0;line-height:1.8}',
    '.bsz-err{color:var(--err);background:var(--err-bg);border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.65}',
    // —— Markdown
    '.bsz-md h2,.bsz-md h3{font-size:14.5px;font-weight:700;margin:16px 0 6px;color:var(--label)}',
    '.bsz-md p,.bsz-md li{font-size:13px;line-height:1.8}',
    '.bsz-md p{margin:6px 0}',
    '.bsz-md li{margin:3px 0}',
    '.bsz-md ul,.bsz-md ol{padding-left:18px;margin:6px 0}',
    '.bsz-md code{background:var(--code-bg);border-radius:6px;padding:1.5px 6px;font-size:12px}',
    '.bsz-md blockquote{border-left:3px solid var(--sep);padding:2px 0 2px 10px;color:var(--label2);margin:8px 0}',
    '.bsz-md a{color:var(--accent)}',
    '.bsz-md strong{font-weight:650}',
    // —— 设置
    '.bsz-field{margin-bottom:12px}',
    '.bsz-field label{display:block;font-size:12px;font-weight:600;color:var(--label2);margin:0 0 5px 2px}',
    '.bsz-field input,.bsz-field select{width:100%;border:none;border-radius:12px;padding:9px 12px;font-size:13px;',
    '  color:var(--label);background:var(--fill);outline:none;transition:box-shadow .15s}',
    '.bsz-field input::placeholder{color:var(--label3)}',
    '.bsz-field input:focus,.bsz-field select:focus{box-shadow:0 0 0 3.5px var(--accent-soft)}',
    '.bsz-hint{font-size:11px;color:var(--label3);line-height:1.7}',
    // —— Toast：玻璃胶囊
    '.bsz-toast{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);',
    '  background:rgba(28,28,30,.78);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);',
    '  color:#fff;font-size:13px;font-weight:500;padding:9px 20px;border-radius:999px;',
    '  box-shadow:0 10px 36px rgba(0,0,0,.30),inset 0 1px 0 rgba(255,255,255,.16)}',
    '.bsz-hide{display:none!important}'
  ].join('\n');

  let root, els = {};

  function segHTML(cls, attr, items, activeKey) {
    return '<div class="bsz-seg ' + cls + '"><div class="bsz-seg-thumb"></div>' +
      items.map(it =>
        '<span class="bsz-seg-item' + (it.key === activeKey ? ' bsz-active' : '') + '" data-' + attr + '="' + it.key + '">' + it.label + '</span>'
      ).join('') + '</div>';
  }

  function buildUI() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'bsz-root';
    root.style.cssText = 'all:initial';
    const shadow = root.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="bsz-fab">✦ AI 总结</div>
      <div class="bsz-panel bsz-hide">
        <div class="bsz-head">
          <span class="bsz-logo">✦</span>
          <span class="bsz-head-title">AI 视频总结</span>
          <span class="bsz-head-btns"><span class="bsz-min" title="收起">—</span><span class="bsz-close" title="关闭">×</span></span>
        </div>
        <div class="bsz-vtitle"></div>
        ${segHTML('bsz-tabs', 'tab', [{ key: 'script', label: '脚本' }, { key: 'summary', label: 'AI 总结' }, { key: 'settings', label: '设置' }], 'script')}
        <div class="bsz-body">
          <div class="bsz-pane" data-pane="script">
            <div class="bsz-pane-top">
              <span class="bsz-meta"></span>
              <button class="bsz-btn bsz-copy-script bsz-hide">复制全文</button>
            </div>
            <div class="bsz-scroll bsz-script"></div>
          </div>
          <div class="bsz-pane bsz-hide" data-pane="summary">
            <div class="bsz-pane-top">
              ${segHTML('bsz-len', 'len', LENGTHS, 'standard')}
              <button class="bsz-btn-primary bsz-gen">生成总结</button>
            </div>
            <div class="bsz-pane-top bsz-status-row bsz-hide">
              <span class="bsz-status"></span>
              <button class="bsz-btn bsz-copy-summary bsz-hide">复制</button>
            </div>
            <div class="bsz-scroll bsz-md bsz-summary"></div>
          </div>
          <div class="bsz-pane bsz-hide" data-pane="settings">
            <div class="bsz-field"><label>接口预设</label><select class="bsz-preset"></select></div>
            <div class="bsz-field"><label>接口地址（Base URL）</label><input class="bsz-base" placeholder="https://…/v4"></div>
            <div class="bsz-field"><label>API Key</label><input type="password" class="bsz-key" placeholder="sk-… / 智谱的 key"></div>
            <div class="bsz-field"><label>模型</label><input class="bsz-model" placeholder="glm-4-flash"></div>
            <div class="bsz-pane-top" style="margin-top:4px">
              <button class="bsz-btn-primary bsz-save">保存</button>
              <span class="bsz-hint">保存在浏览器里，只发给你填的接口。智谱 / DeepSeek / Kimi 等 OpenAI 兼容接口都可以。</span>
            </div>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(root);

    els.fab = shadow.querySelector('.bsz-fab');
    els.panel = shadow.querySelector('.bsz-panel');
    els.vtitle = shadow.querySelector('.bsz-vtitle');
    els.tabs = shadow.querySelector('.bsz-tabs');
    els.meta = shadow.querySelector('.bsz-meta');
    els.copyScript = shadow.querySelector('.bsz-copy-script');
    els.script = shadow.querySelector('.bsz-script');
    els.lenSeg = shadow.querySelector('.bsz-len');
    els.gen = shadow.querySelector('.bsz-gen');
    els.statusRow = shadow.querySelector('.bsz-status-row');
    els.status = shadow.querySelector('.bsz-status');
    els.copySummary = shadow.querySelector('.bsz-copy-summary');
    els.summary = shadow.querySelector('.bsz-summary');
    els.preset = shadow.querySelector('.bsz-preset');
    els.base = shadow.querySelector('.bsz-base');
    els.key = shadow.querySelector('.bsz-key');
    els.model = shadow.querySelector('.bsz-model');

    els.preset.innerHTML = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');

    els.fab.addEventListener('click', openPanel);
    shadow.querySelector('.bsz-min').addEventListener('click', closePanel);
    shadow.querySelector('.bsz-close').addEventListener('click', closePanel);
    els.tabs.querySelectorAll('.bsz-seg-item').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    els.lenSeg.querySelectorAll('.bsz-seg-item').forEach(i => i.addEventListener('click', () => setLength(i.dataset.len)));
    els.copyScript.addEventListener('click', copyTranscript);
    els.gen.addEventListener('click', startSummary);
    els.copySummary.addEventListener('click', copySummary);
    els.preset.addEventListener('change', () => {
      const pre = PRESETS[els.preset.value];
      if (pre && pre.base) { els.base.value = pre.base; els.model.value = pre.model; }
    });
    shadow.querySelector('.bsz-save').addEventListener('click', saveSettings);

    // 点击时间戳跳转视频进度（事件委托）
    els.script.addEventListener('click', e => {
      const t = e.target.closest('.bsz-t');
      if (!t) return;
      const v = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('video');
      if (!v) return;
      v.currentTime = Number(t.dataset.t) || 0;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    });
  }

  // 分段控件滑块跟随 active 项
  function moveThumb(seg) {
    const items = Array.from(seg.querySelectorAll('.bsz-seg-item'));
    const idx = Math.max(0, items.findIndex(i => i.classList.contains('bsz-active')));
    const thumb = seg.querySelector('.bsz-seg-thumb');
    if (thumb) thumb.style.transform = 'translateX(' + idx * 100 + '%)';
  }

  function switchTab(name) {
    els.tabs.querySelectorAll('.bsz-seg-item').forEach(t => t.classList.toggle('bsz-active', t.dataset.tab === name));
    moveThumb(els.tabs);
    root.shadowRoot.querySelectorAll('.bsz-pane').forEach(p => p.classList.toggle('bsz-hide', p.dataset.pane !== name));
  }

  async function setLength(len) {
    cfg.summaryLength = len;
    els.lenSeg.querySelectorAll('.bsz-seg-item').forEach(i => i.classList.toggle('bsz-active', i.dataset.len === len));
    moveThumb(els.lenSeg);
    try { await chrome.storage.sync.set({ summaryLength: len }); } catch (_) { /* 存不上也不影响本次 */ }
  }

  function openPanel() {
    panelOpen = true;
    els.fab.classList.add('bsz-hide');
    els.panel.classList.remove('bsz-hide');
    moveThumb(els.tabs); moveThumb(els.lenSeg);
    if (!state.info && !state.loading) loadAll();
  }
  function closePanel() {
    panelOpen = false;
    els.panel.classList.add('bsz-hide');
    els.fab.classList.remove('bsz-hide');
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'bsz-toast';
    el.textContent = msg;
    root.shadowRoot.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  const scriptErr = msg => { els.script.innerHTML = '<div class="bsz-err">' + escapeHtml(msg) + '</div>'; els.meta.textContent = ''; };

  // ---------------- 主流程 ----------------
  async function loadAll() {
    state.loading = true;
    els.script.innerHTML = '<div class="bsz-empty">正在读取字幕…</div>';
    els.vtitle.textContent = '';
    els.meta.textContent = '';
    els.copyScript.classList.add('bsz-hide');
    try {
      const info = await getVideoInfo();
      state.info = info;
      els.vtitle.textContent = (info.pages > 1 ? 'P' + info.page + ' · ' : '') + info.title + '（' + fmt(info.duration) + '）';

      const subs = await getSubtitleList(info);
      const sub = pickSubtitle(subs);
      if (!sub) {
        scriptErr('没有找到这个视频的字幕。AI 字幕需要登录 B 站账号后才有；纯画面 / 音乐类视频可能没有字幕。');
        return;
      }
      state.lanDoc = sub.lan_doc || sub.lan || '字幕';
      const body = await fetchSubtitleBody(sub);
      state.segs = buildSegments(body);
      state.transcript = state.segs.map(s => '[' + fmt(s.start) + '] ' + s.text).join('\n');

      els.meta.textContent = state.lanDoc + ' · ' + state.segs.length + ' 段';
      els.script.innerHTML = state.segs
        .map(s => '<p class="bsz-line"><span class="bsz-t" data-t="' + s.start + '">[' + fmt(s.start) + ']</span>' + escapeHtml(s.text) + '</p>')
        .join('');
      els.copyScript.classList.remove('bsz-hide');
    } catch (e) {
      scriptErr('字幕读取失败：' + ((e && e.message) || e));
    } finally {
      state.loading = false;
    }
  }

  function copyTranscript() {
    if (!state.transcript) return;
    const md = '# ' + state.info.title + '\n> 来源：' + location.href + '\n> 字幕：' + state.lanDoc + '\n\n' + state.transcript + '\n';
    navigator.clipboard.writeText(md).then(() => toast('已复制字幕全文'), () => toast('复制失败'));
  }

  function copySummary() {
    if (!state.summaryRaw) return;
    navigator.clipboard.writeText(state.summaryRaw).then(() => toast('已复制总结'), () => toast('复制失败'));
  }

  function startSummary() {
    if (state.summarizing) return;
    if (!state.transcript) { toast('字幕还没加载好'); return; }
    if (!cfg.apiKey) { switchTab('settings'); els.status.textContent = '先填 API Key 再生成'; els.statusRow.classList.remove('bsz-hide'); return; }

    state.summarizing = true;
    state.summaryRaw = '';
    els.summary.innerHTML = '';
    els.statusRow.classList.remove('bsz-hide');
    els.status.textContent = '正在阅读字幕…';
    els.copySummary.classList.add('bsz-hide');
    els.gen.disabled = true;

    if (aiPort) { try { aiPort.disconnect(); } catch (_) {} }
    aiPort = chrome.runtime.connect({ name: 'bsz-ai' });

    let renderTimer = null;
    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        els.summary.innerHTML = mdRender(state.summaryRaw);
        els.summary.scrollTop = els.summary.scrollHeight;
      }, 90);
    };

    aiPort.onMessage.addListener(msg => {
      if (msg.status) els.status.textContent = msg.status;
      if (msg.delta) { state.summaryRaw += msg.delta; scheduleRender(); }
      if (msg.done) {
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        els.summary.innerHTML = mdRender(state.summaryRaw);
        els.status.textContent = '';
        els.copySummary.classList.remove('bsz-hide');
        els.gen.disabled = false;
        els.gen.textContent = '重新生成';
        state.summarizing = false;
        try { aiPort.disconnect(); } catch (_) {}
      }
      if (msg.error) {
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        els.status.textContent = '';
        els.summary.innerHTML = mdRender(state.summaryRaw) + (state.summaryRaw ? '<br>' : '') + '<div class="bsz-err">' + escapeHtml(msg.error) + '</div>';
        els.gen.disabled = false;
        state.summarizing = false;
      }
    });

    aiPort.onDisconnect.addListener(() => {
      if (!state.summarizing) return;
      els.status.textContent = '';
      els.gen.disabled = false;
      if (!state.summaryRaw) els.summary.innerHTML = '<div class="bsz-err">生成中断了，请重试</div>';
      state.summarizing = false;
    });

    aiPort.postMessage({ type: 'summarize', config: cfg, subtitleText: state.transcript });
  }

  // ---------------- 设置 ----------------
  async function loadSettings() {
    try {
      const saved = await chrome.storage.sync.get(DEFAULTS);
      cfg = { ...DEFAULTS, ...saved };
    } catch (_) { cfg = { ...DEFAULTS }; }
    els.preset.value = cfg.preset || 'zhipu';
    els.base.value = cfg.apiBase || '';
    els.key.value = cfg.apiKey || '';
    els.model.value = cfg.model || '';
    els.lenSeg.querySelectorAll('.bsz-seg-item').forEach(i => i.classList.toggle('bsz-active', i.dataset.len === cfg.summaryLength));
    moveThumb(els.lenSeg);
  }
  async function saveSettings() {
    cfg = {
      preset: els.preset.value,
      apiBase: els.base.value.trim(),
      apiKey: els.key.value.trim(),
      model: els.model.value.trim(),
      summaryLength: cfg.summaryLength || 'standard'
    };
    try { await chrome.storage.sync.set(cfg); toast('已保存'); }
    catch (_) { toast('保存失败'); }
  }

  // ---------------- SPA 路由监听（切视频 / 切 P 自动重置） ----------------
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const oldPanel = panelOpen;
    state.info = null; state.segs = []; state.transcript = ''; state.lanDoc = '';
    state.summaryRaw = '';
    els.summary.innerHTML = '';
    els.statusRow.classList.add('bsz-hide');
    els.gen.textContent = '生成总结';
    els.copySummary.classList.add('bsz-hide');
    if (oldPanel && !state.loading) loadAll();
  }, 1500);

  // ---------------- 启动 ----------------
  buildUI();
  loadSettings();
})();
