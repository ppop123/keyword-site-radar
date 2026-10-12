// 侧边栏测试页 2：假的关键词表（12 页 × 100 行）+ 内存版快照服务，用来跑通收集 / 对比 / 导出。
// 需要先加载 stub.js（复用其中域名的 CANNED 数据）。
(() => {
  const PAGES = 12, SIZE = 100;
  // 第 1 页前面几十行用像真的词（长短不一），排版评审时看得出换行；后面照旧用 kw 页-行
  const REAL_KW = ['arrange pdf pages', 'remover security of pdf file', 'pdflover png to pdf', 'how do i save a pdf as under 10mb',
    'compress pdf to 100kb', 'merge pdf', 'pdf to jpg converter free online without watermark', 'unlock pdf', 'split pdf by pages',
    'sign pdf', 'rotate pdf pages permanently', 'pdf to word', 'ocr pdf', 'edit pdf text online free', 'heic to pdf',
    'pdf page numbers', 'watermark pdf', 'flatten pdf', 'pdf to markdown', 'jpg to pdf under 200kb', 'crop pdf', 'pdf reader',
    'organize pdf', 'pdf to excel', 'reduce pdf size', 'protect pdf with password', 'add text to pdf', 'pdf to png high quality',
    'delete pages from pdf', 'extract images from pdf', 'pdf metadata remover', 'grayscale pdf', 'pdf compare', 'repair pdf',
    'pdf to epub', 'scan to pdf', 'resize pdf pages to a4', 'pdf annotator', 'pdf form filler', 'pdf translator', 'pdf to pptx',
    'insert page into pdf', 'pdf to tiff', 'invert pdf colors', 'pdf booklet maker', 'n-up pdf', 'pdf to svg', 'pdf highlighter',
    'redact pdf', 'pdf bates numbering'];
  const kwOf = (p, i) => (p === 1 && i < REAL_KW.length ? REAL_KW[i] : `kw ${p}-${i}`);
  // 每页偶数行达标；每 10 行一个红
  const TOP = ['https://www.ilovepdf.com/organize-pdf?x=', 'https://smallpdf.com/pdf-tools?x=', 'https://www.adobe.com/acrobat/online/pdf-to-jpg.html?x=',
    'https://pdfflex-new-tool.app/arrange?x=', 'https://pdf-page-arranger-online.vercel.app/?x=', 'https://www.sejda.com/organize-pdf-pages?x=', 'https://tools.pdf24.org/en/?x='];
  const row = (p, i) => (p === 1 && i === 8
    ? { i, kw: kwOf(p, i), kd: '-', t: '6.2K', v: '< 50', ratio: 123.4, ge: true, red: true, url: `http://example.com/${p}/${i}` }  // 极值：倍数列放不放得下
    : { i, kw: kwOf(p, i), kd: '-', t: '1.2K', v: '100', ratio: i % 10 === 0 ? 30 : 8, ge: false, red: i % 10 === 0, url: TOP[(p * 7 + i) % TOP.length] + `${p}-${i}` });
  const page = { cur: 1 };
  const url = 'https://sim.3ue.co/#/organicsearch/pageAnalysis/website-keyword-v2/*/999/28d?key=test.com&Change=New';
  const sort = '点击量 降序';
  const scan = () => ({
    ctx: url + '|' + sort, url, sort, cur: page.cur, total: PAGES, pageSize: SIZE, hasNext: page.cur < PAGES,
    items: Array.from({ length: SIZE }, (_, i) => i).filter((i) => i % 2 === 0).map((i) => row(page.cur, i)),
    all: Array.from({ length: SIZE }, (_, i) => kwOf(page.cur, i)),
  });
  window.__fake = { page, calls: [] };
  const fakeHot = {
    start: () => scan(),
    scan,
    next: async () => { await new Promise((r) => setTimeout(r, 30)); if (page.cur >= PAGES) return false; page.cur++; return true; },
    goto: async (n) => { await new Promise((r) => setTimeout(r, 30)); page.cur = n; return true; },
    stop: () => true,
  };

  window.__tabUrl = url;
  chrome.tabs.query = async () => [{ id: 7, url: window.__tabUrl }];
  chrome.tabs.onUpdated = { addListener() {} };
  chrome.scripting.executeScript = async ({ func, files, args }) => {
    if (files) return [{}];
    if (func.name === 'collectHosts') return [{ result: CANNED.page }];
    const [name, a] = args;
    window.__fake.calls.push(name + (a.length ? `(${a.join(',')})` : ''));
    return [{ result: await fakeHot[name](...a) }];
  };

  // 内存版快照服务（规则同 server.py：同表同天只留一份；today 之前的才当基线）
  const store = { snaps: [], seen: {}, id: 0 };
  const day = (ts) => new Date(ts * 1000).toLocaleDateString('sv');
  const now = () => Math.floor(Date.now() / 1000);
  window.__store = store;
  // 预置一份「7 天前」的基线：扫过前 6 页。预期首次出现 = 3 + 2 + 第 7–10 页的 200 = 205，消失 2
  const baseItems = [];
  for (let p = 1; p <= 6; p++) {
    for (let i = 0; i < SIZE; i++) {
      const kw = kwOf(p, i), rank = (p - 1) * SIZE + i + 1, pass = i % 2 === 0, red = i % 10 === 0;
      if (p === 1 && [2, 4, 6].includes(i)) continue;                         // 上次没有 → 「首次出现」
      if (p === 2 && [2, 4].includes(i)) { baseItems.push({ kw, rank }); continue; }  // 上次在表里但没达标 → 也算「首次出现」
      if (p === 3 && i === 10) { baseItems.push({ kw, rank, pass: 1, red: 0 }); continue; }  // 上次橙这次红 → 不标（上次名单里有）
      baseItems.push(pass ? { kw, rank, pass: 1, red: red ? 1 : 0 } : { kw, rank });
    }
  }
  baseItems.push({ kw: 'gone a', rank: 150, pass: 1, red: 0 }, { kw: 'gone b', rank: 420, pass: 1, red: 1 }); // → 「消失」2 个
  const t7 = now() - 7 * 86400;
  store.snaps.push({ id: ++store.id, kind: 'hot', key: url + '|' + sort, family: url, label: sort, created_at: t7, day: day(t7), coverage: 600, n: baseItems.length, items: baseItems });
  // 同一张表但排序不同的旧快照（第一次查别的排序时应提示「不能比」）
  store.snaps.push({ id: ++store.id, kind: 'hot', key: url + '|28 天流量 降序', family: url, label: '28 天流量 降序', created_at: t7, day: day(t7), coverage: 100, n: 1, items: [{ kw: 'x', rank: 1 }] });

  const meta = (s) => ({ id: s.id, label: s.label, created_at: s.created_at, day: s.day, coverage: s.coverage, n: s.n });
  const handlers = {
    '/snapshot/list': ({ kind, key, family }) => ({
      snapshots: store.snaps.filter((s) => s.kind === kind && s.key === key).sort((a, b) => b.created_at - a.created_at).map(meta),
      others: family ? store.snaps.filter((s) => s.kind === kind && s.family === family && s.key !== key).map(meta) : [],
    }),
    '/snapshot/get': ({ id }) => ({ items: store.snaps.find((s) => s.id === id)?.items || null }),
    '/snapshot/save': ({ kind, key, family, label, coverage, items }) => {
      const ts = now();
      store.snaps = store.snaps.filter((s) => !(s.kind === kind && s.key === key && s.day === day(ts)));
      store.snaps.push({ id: ++store.id, kind, key, family, label, created_at: ts, day: day(ts), coverage, n: items.length, items });
      return { id: store.id };
    },
    '/snapshot/seen': ({ domains }) => {
      for (const d of domains) if (!store.seen[d]) store.seen[d] = now();
      return { seen: Object.fromEntries(domains.map((d) => [d, store.seen[d]])), since: Math.min(...Object.values(store.seen)) };
    },
  };
  const realFetch = window.fetch;
  window.fetch = async (u, opts) => {
    const path = new URL(u).pathname;
    if (handlers[path]) {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => handlers[path](body) };
    }
    return realFetch(u, opts);  // /normalize、/lookup 走 stub.js 的假数据
  };
  // 拦截下载
  window.__downloads = [];
  URL.createObjectURL = (b) => { window.__lastBlob = b; return 'blob:test'; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push(this.download); };
})();

chrome.tabs.onRemoved = { addListener(fn) { window.__onRemoved = fn; } };
