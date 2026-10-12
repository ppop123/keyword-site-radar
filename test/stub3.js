// 测试页 3：假的 web.cafe 列表页（结构照真实页面：main 里一张卡片一个 a[href^="/keywords/"]）+ chrome.storage.local
(() => {
  const card = (kw, dir, tags, verdict, gpts, desc) =>
    `<a href="/keywords/${kw.replace(/ /g, '-')}?tab=x"><div><span>${kw}</span><span>${dir}</span>${tags.map((t) => `<span>${t}</span>`).join('')}</div>` +
    `<p>${desc}</p><span>${verdict}</span><span>做内页 ·</span><div><span>GPTs</span><span>×${gpts}</span></div><span>3</span><span>12</span></a>`;
  const PAGES = {
    evergreen: [
      [card('jpg to pdf', '工具', ['老词'], '可以试试', 2776.5, 'JPG 转 PDF 是一种在线工具，可将图片转换为 PDF'), card('free ai', 'AI', ['老词'], '值得做', 94.6, '免费的AI人工智能工具与服务，覆盖聊天机器人'), card('lagos life', '游戏', ['二次爆火', '回落中'], '可以试试', 460, 'Lagos Life是一款免费的浏览器生活模拟游戏')],
      [card('lanterns', '其它', ['二次爆火', '回落中'], '可以试试', 262.2, 'HBO 在 2026 年推出的 DC 超级英雄剧集《Lanterns》'), card('pdf to jpg', '工具', ['老词'], '可以试试', 1394.5, 'PDF 转 JPG 工具，可将 PDF 文件的每一页转换')],
    ],
    resurgence: [
      [card('caretakers roblox', '游戏', ['二次爆火', '上升中'], '可以试试', 0.024, '这是一款 Roblox 平台上的恐怖游戏《CareTakers》'), card('lagos life', '游戏', ['二次爆火', '回落中'], '可以试试', 460, 'Lagos Life是一款免费的浏览器生活模拟游戏')],
    ],
  };
  const FOUND = { evergreen: 5, resurgence: 2 };
  window.__wcCalls = 0;
  window.__wcLoggedOut = false;
  const prevFetch = window.fetch;
  window.fetch = async (u, opts) => {
    const url = new URL(u, location.href);
    if (url.hostname !== 'new.web.cafe') return prevFetch(u, opts);
    window.__wcCalls++;
    const tab = url.searchParams.get('tab'), page = +url.searchParams.get('page');
    const pages = PAGES[tab];
    const body = window.__wcLoggedOut ? '<main><p>请先登录</p></main>'
      : `<main><div>近 7 天热度在 GPTs 的 2 倍以上 · 找到 ${FOUND[tab]} 个</div>${pages[page - 1].join('')}<div>第 ${page} / ${pages.length} 页</div></main>`;
    return { ok: true, status: 200, text: async () => `<html><body>${body}</body></html>` };
  };
  const store = {};
  chrome.storage = { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async (k) => { delete store[k]; } } };
  window.__wcStore = store;
})();
