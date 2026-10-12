// 测试页 4：假的 sim 引荐网站页（结构照 10-12 实测：表头 4 栏在 wrapper 外、数据 4 栏在 wrapper 里，
// 翻页时整张表连同页码栏先拆掉、300ms 后画回来，页码框先显示 1、稍后才变成真页码）。
// 页面放在 iframe 里，真的把 extension/ref.js 注入进去跑（用 iframe 自己的 fetch 取文件：测试页 2/3 换掉了 window.fetch）。
(() => {
  const REF = 'https://sim.3ue.co/#/digitalsuite/websiteanalysis/referrals/*/999/28d?webSource=Total&selectedTab=incomingTraffic&key=checkout.stripe.com';
  const N = 974, SIZE = 100;
  const IND = ['计算机电子与技术', 'Programming and Developer Software', 'Games', 'Tennis', '艺术与娱乐', ''];
  // 前几行用 10-12 在真实引荐页上看到的域名和行业，排版评审时看得出长域名、中英混排的样子
  const REAL = [['higgsfield.ai', '计算机电子与技术'], ['elevenlabs.io', 'Programming and Developer Software'], ['topview.ai', 'Graphics Multimedia and Web Design'],
    ['journaldesfemmes.fr', '未知'], ['playtennis.usta.com', 'Tennis'], [null], ['drmax.pl', 'Biotechnology and Pharmaceuticals'], [null],
    ['gamebillet.com', 'Video Games Consoles and Accessories'], ['activities.bookpebble.co.uk', '未知'], ['evolink.ai', 'Programming and Developer Software'],
    ['yepbooking.com.au', 'Travel and Tourism'], ['mai-ko.com', '未知'], ['jpx-jquants.com', 'Finance'], ['app.mailerfind.com', 'Marketing and Advertising']];
  const rows = Array.from({ length: N }, (_, i) => ({
    d: i === 5 ? 'similarweb.com' : i === 7 ? 'pro.similarweb.com' : REAL[i]?.[0] || `site${i}.com`,
    ind: REAL[i]?.[1] || IND[i % IND.length], rank: i % 9 === 0 ? '-' : `#${(i + 1) * 37}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    share: `${(7 - i * 0.007).toFixed(2)}%`, sub: i === 3 ? 2 : 0,
  }));
  const page = `<!doctype html><html><body><div id="app"></div><script>
    const rows = ${JSON.stringify(rows)}, SIZE = ${SIZE}, PAGES = Math.ceil(rows.length / SIZE);
    let cur = 1;
    window.__href = ${JSON.stringify(REF)};  // iframe 的地址是 about:srcdoc：读表结果里的 href 换成它（可改，模拟用户跳到别的页面）
    const app = document.getElementById('app');
    const col = (cells) => '<div class="u-relative swReactTable-column">' + cells.map((c) => '<div class="swReactTableCell swTable-cell">' + c + '</div>').join('') + '<div class="resizeable-border"></div></div>';
    function draw() {
      const rs = rows.slice((cur - 1) * SIZE, cur * SIZE);
      const head = ['域 (' + rows.length + ')', '行业', '全球排名', '流量份额'].map((h) => '<div class="u-relative swReactTable-column"><div>' + h + '</div><div></div></div>').join('');
      app.innerHTML = '<div class="hdr">' + head + '</div><div class="swReactTable-wrapper">' +
        col(rs.map((r) => '<div class="domain-cell"><div class="swTable-content-small text"><a href="#" class="cell-clickable">' + r.d + '</a></div>' + (r.sub ? '<span>(' + r.sub + ')</span>' : '') + '</div>')) +
        col(rs.map((r) => r.ind)) + col(rs.map((r) => r.rank)) + col(rs.map((r) => r.share)) + '</div>' +
        '<div class="bar"><div class="a"><svg></svg></div><div class="a"><svg></svg></div><div><div><input value="1"></div><span>out of ' + PAGES + '</span></div><div class="a"><svg></svg></div><div class="a"><svg></svg></div></div>';
      const inp = app.querySelector('input');
      // 页码框先显示 1，稍后才变成真页码：默认排在页面变化通知之后；__inputLag 毫秒 = 模拟更慢的更新（Codex 10-12 #5）
      const lag = window.parent.__inputLag || 0;
      if (lag) setTimeout(() => { inp.value = String(cur); }, lag); else queueMicrotask(() => { inp.value = String(cur); });
      app.querySelectorAll('.bar .a').forEach((b, i) => b.addEventListener('click', () => go([1, cur - 1, cur + 1, PAGES][i])));
    }
    function go(n) {
      if (n < 1 || n > PAGES || n === cur) return;
      cur = n; app.innerHTML = '<div class="loading"></div>';
      window.__flips = (window.__flips || 0) + 1;
      setTimeout(draw, 300);
    }
    setTimeout(draw, window.parent.__refLoadDelay || 500);
  <\/script></body></html>`;

  let frame = null;
  function load() {
    frame?.remove();
    frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px';
    frame.srcdoc = page;
    document.body.appendChild(frame);
    window.__refFrame = frame;
  }
  const REF_TAB = 55;            // 「用户已经开着」的那个引荐页
  let nextTab = 60;              // 后台新开的引荐页从 60 起编号，每开一个换一个号（测标签页归属）
  window.__refTabs = new Set([REF_TAB]);
  window.__refOpen = false;     // true：假装用户已经开着引荐页
  window.__removedTabs = [];
  const prevQuery = chrome.tabs.query, prevCreate = chrome.tabs.create, prevExec = chrome.scripting.executeScript;
  chrome.tabs.query = async (q) => {
    if (q && q.url === 'https://sim.3ue.co/*') return window.__refOpen ? [{ id: REF_TAB, url: REF }] : [{ id: 7, url: 'https://sim.3ue.co/#/home' }];
    return prevQuery(q);
  };
  chrome.tabs.create = async (opts) => {
    if (/websiteanalysis\/referrals/.test(opts.url) && opts.active === false) {
      const id = nextTab++;
      window.__refTabs.add(id);
      window.__refCreatedIds = [...(window.__refCreatedIds || []), id];
      window.__refCreated = opts; load(); return { id };
    }
    return prevCreate(opts);
  };
  chrome.tabs.remove = async (id) => { window.__removedTabs.push(id); };
  chrome.tabs.get = async (id) => {
    if (window.__refTabs.has(id) && !window.__removedTabs.includes(id)) return { id, url: frame?.contentWindow.__href || REF, active: false };
    throw new Error('No tab with id: ' + id);
  };
  window.__refBroken = false;  // true：假装引荐页被关掉（测出错卡片）
  chrome.scripting.executeScript = async (o) => {
    if (!window.__refTabs.has(o.target.tabId)) return prevExec(o);
    if (window.__refBroken || window.__removedTabs.includes(o.target.tabId)) throw new Error('No tab with id: ' + o.target.tabId);
    if (o.files && window.__hangInject) return new Promise(() => {});  // 注入一直不回（页面迟迟没到 document_idle）
    if (o.args?.[0] === 'cancel' && window.__slowCancel) await new Promise((r) => setTimeout(r, window.__slowCancel));
    const w = frame.contentWindow;
    if (w.document.readyState !== 'complete') throw new Error('Frame is still loading');
    if (o.files) { w.eval(await (await w.fetch(new URL('../extension/' + o.files[0], location.href).href)).text()); return [{}]; }
    // ref.js 翻页前会拿侧边栏给的地址和 location.href 比；iframe 的地址是 about:srcdoc：
    // 侧边栏给的就是当前假地址 → 换成 iframe 真地址（没跳走）；不是 → 换成别的（跳走了）
    if (Array.isArray(o.args?.[1]) && typeof o.args[1][0] === 'string') o.args[1][0] = o.args[1][0] === w.__href ? w.location.href : 'about:moved';
    const result = await w.eval('(' + o.func.toString() + ')').apply(null, o.args || []);
    if (result && typeof result === 'object' && 'href' in result) result.href = w.__href;
    return [{ result }];
  };
  window.__refLoad = load;
  // 本机服务在找站这边的两个接口：/normalize 把主机名归到可注册域名（够用的简化版公共后缀），
  // /lookup 给确定的假注册日；cachedOnly 只回一半（假装另一半还没查过），没查过的单个查要 20ms
  const hash = (t) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const regOf = (d) => {
    if (d === 'evolink.ai' || d === 'mai-ko.com' || hash(d) % 7 === 0) return new Date(Date.now() - (20 + hash(d) % 300) * 86400000).toLocaleDateString('sv');
    return `${2005 + hash(d) % 19}-0${1 + hash(d) % 9}-1${hash(d) % 9}`;
  };
  const registrable = (h) => { const l = h.split('.'); return l.slice(/^(co|com)\.(uk|au)$/.test(l.slice(-2).join('.')) ? -3 : -2).join('.'); };
  window.__lookups = { cachedOnly: 0, single: 0 };
  const prevFetch = window.fetch;
  window.fetch = async (u, opts) => {
    const path = new URL(u, location.href).pathname;
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (path === '/normalize' && body.hosts?.some((x) => /^site\d+\.com$/.test(x.h))) {  // 只接找站那批（域名视图照旧走 stub.js）
      if (window.__serviceDown) throw new TypeError('Failed to fetch');
      const by = new Map();
      for (const { h } of body.hosts) { const d = registrable(h); const it = by.get(d) || { domain: d, hosted: null, self: false, n: 0, via: ['link'], hosts: [] }; it.hosts.push(h); by.set(d, it); }
      return { ok: true, status: 200, json: async () => ({ items: [...by.values()] }) };
    }
    if (path === '/lookup' && !body.domains.some((d) => d in CANNED.results)) {
      if (body.cachedOnly) {
        window.__lookups.cachedOnly++;
        return { ok: true, status: 200, json: async () => ({ results: Object.fromEntries(body.domains.filter((d) => hash(d) % 2 === 0).map((d) => [d, { reg: regOf(d), source: 'RDAP', cached: true }])) }) };
      }
      window.__lookups.single++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ results: Object.fromEntries(body.domains.map((d) => [d, { reg: regOf(d), source: 'whois', cached: false }])) }) };
    }
    return prevFetch(u, opts);
  };
  // 记下侧边栏注册的「切换标签页」监听，测试里可以假装用户切到了某个标签页
  window.__onActivated = [];
  chrome.tabs.onActivated = { addListener: (fn) => window.__onActivated.push(fn) };
  // 写缓存慢一点（毫秒），测「写的时候点停止」
  window.__slowSet = 0;
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => { if (window.__slowSet) await new Promise((r) => setTimeout(r, window.__slowSet)); return realSet(o); };
  // 上一份：site0–site899 里去掉 site10–site19，所以本月首次出现 = site10–19 + site900–973
  const prevItems = rows.slice(0, 900).filter((_, i) => i < 10 || i >= 20).filter((r) => !/similarweb/.test(r.d))
    .map((r, i) => ({ d: r.d, industry: r.ind, grank: r.rank, share: r.share, sub: r.sub, rank: i + 1 }));
  // daysAgo：这份存了多少天（≥30 会自动重拉，<30 不动）
  window.__seedRefCache = (daysAgo) => { window.__wcStore['stripe-ref-v1'] = { items: prevItems, at: Date.now() - daysAgo * 86400000, total: 900, prev: null }; };
})();
