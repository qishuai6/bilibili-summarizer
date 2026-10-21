// 跑在页面主世界：读 B 站页面自带数据、以页面身份请求 B 站接口（带登录 cookie，
// 与 B 站前端同源环境，绕开扩展环境的风控差异）。与内容脚本用 postMessage 通信。
(() => {
  if (window.__BSZ_INJECT__) return;
  window.__BSZ_INJECT__ = true;

  const pageOf = () => {
    const p = parseInt(new URLSearchParams(location.search).get('p'), 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  const waitState = async () => {
    for (let i = 0; i < 20; i++) {
      if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData) return window.__INITIAL_STATE__;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('页面数据未就绪，刷新一下再试');
  };

  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data || e.data.dir !== 'bsz-in') return;
    const { cmd, id, payload } = e.data;
    const reply = (result, error) =>
      window.postMessage({ dir: 'bsz-out', id, result, error }, location.origin);
    try {
      let result;
      if (cmd === 'video-info') {
        const s = await waitState();
        const vd = s.videoData;
        const p = pageOf();
        const page = (vd.pages || []).find(pg => pg.page === p) || (vd.pages || [])[0];
        const cid = (page && page.cid) || vd.cid;
        if (!cid) throw new Error('没拿到视频 cid');
        result = {
          bvid: vd.bvid,
          aid: vd.aid,
          title: vd.title,
          duration: (page && page.duration) || vd.duration,
          page: p,
          pages: (vd.pages || []).length || 1,
          cid
        };
      } else if (cmd === 'fetch') {
        const res = await fetch(payload.url, { credentials: 'include' });
        result = { ok: res.ok, status: res.status, text: await res.text() };
      } else {
        throw new Error('未知指令 ' + cmd);
      }
      reply(result);
    } catch (err) {
      reply(undefined, String((err && err.message) || err));
    }
  });
})();
