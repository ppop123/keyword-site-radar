// 「找站」生命周期场景测试（对应 Codex 10-12 审查的 8 条）：node test/refs-check.cjs
// 跑在测试页 4 上：假 sim 引荐页在 iframe 里，真把 extension/ref.js 注入进去。
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('/Users/wy/cafe/pdftojpg/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4994;
const URL = `http://127.0.0.1:${PORT}/test/panel-harness4.html`;
const until = (p, fn, arg, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const state = (p) => p.evaluate(() => ({
  status: R.status, n: R.items.length, err: R.err?.message || null, job: !!refJob,
  created: window.__refCreatedIds || [], removed: [...window.__removedTabs],
  saved: window.__wcStore['stripe-ref-v1']?.items?.length ?? null, owned: window.__wcStore['stripe-ref-tab'] ?? null,
  prevAt: window.__wcStore['stripe-ref-v1']?.prev?.at ?? null,
}));

const CASES = {
  async '正常拉取：读满、关掉自己开的标签页、不留归属记录'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob);
    const s = await state(p);
    return [s.n === 972 && s.saved === 972, s.created.length === 1 && s.removed.includes(s.created[0]), s.owned === null, s];
  },
  async '#3 双击 / 连点：只开一轮'(p) {
    await p.evaluate(() => { document.getElementById('tab-refs').click(); loadRefs({ force: true }); loadRefs({ force: true }); });
    await until(p, () => R.status === 'done' && !refJob);
    const s = await state(p);
    return [s.created.length === 1, s.n === 972, s];
  },
  async '#2/#4 停止：马上关标签页、不写缓存、显示已停止'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.page >= 2);
    await p.click('[data-act=r-stop]');
    await until(p, () => !refJob && R.status !== 'loading');
    await p.waitForTimeout(1500);  // 旧的一轮如果还会写缓存，给它时间
    const s = await state(p);
    return [s.status === 'stopped', s.saved === null, s.removed.includes(s.created[0]), s];
  },
  async '#2 停止后马上重拉：旧一轮只关自己的标签页，新一轮正常读完'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.page >= 2);
    await p.evaluate(() => { stopRefs(); loadRefs({ force: true }); });
    await until(p, () => R.status === 'done' && !refJob && (window.__refCreatedIds || []).length === 2);
    const s = await state(p);
    const [a, b] = s.created;
    return [s.n === 972 && s.saved === 972, s.removed.filter((x) => x === a).length === 1 && s.removed.includes(b), s];
  },
  async '#1 用户开着的引荐页中途跳到别的域名：停下、不存、不再翻它'(p) {
    await p.evaluate(() => { window.__refOpen = true; window.__refLoadDelay = 10; window.__refLoad(); });
    await until(p, () => !!window.__refFrame.contentWindow.document.querySelector('.swReactTable-wrapper'));
    await p.click('#tab-refs');
    await until(p, () => R.page >= 2);
    await p.evaluate(() => { window.__refFrame.contentWindow.__href = window.__refFrame.contentWindow.__href.replace('checkout.stripe.com', 'other.com'); });
    await until(p, () => !refJob && R.status !== 'loading');
    const flipsAfter = await p.evaluate(() => window.__refFrame.contentWindow.__flips);
    await p.waitForTimeout(1500);
    const flipsLater = await p.evaluate(() => window.__refFrame.contentWindow.__flips);
    const s = await state(p);
    return [/跳到别的页面/.test(s.err || ''), s.saved === null, s.created.length === 0, flipsAfter === flipsLater, s];
  },
  async '#5 页码框 0.9 秒后才更新：照样读完、名次对'(p) {
    await p.evaluate(() => { window.__inputLag = 900; });
    await p.click('#tab-refs');
    await until(p, () => !refJob && R.status !== 'loading', null, 120000);
    const s = await state(p);
    const ranks = await p.evaluate(() => R.items.slice(0, 3).map((x) => x.rank).concat(R.items.at(-1).rank));
    return [s.n === 972 && !s.err, JSON.stringify(ranks) === '[1,2,3,974]', { ...s, ranks }];
  },
  async '#6 等新页时取消：观察器断开、等待结束'(p) {
    await p.evaluate(() => { window.__refLoadDelay = 10; window.__refLoad(); });
    await until(p, () => !!window.__refFrame.contentWindow.document.querySelector('.swReactTable-wrapper'));
    const r = await p.evaluate(async () => {
      const w = window.__refFrame.contentWindow;
      let live = 0;
      const MO = w.MutationObserver;
      w.MutationObserver = class extends MO { observe(...a) { live++; return super.observe(...a); } disconnect() { live--; return super.disconnect(); } };
      w.eval(await (await w.fetch(new URL('../extension/ref.js', location.href).href)).text());
      w.go = () => {};  // 点了「下一页」但页面没反应
      const pending = w.__pkRef.next();
      await new Promise((res) => setTimeout(res, 200));
      const before = live;
      w.__pkRef.cancel();
      const result = await pending;
      return { before, after: live, result };
    });
    return [r.before === 1 && r.after === 0 && r.result === false, r];
  },
  async '#7 侧边栏中途关掉留下的后台页：下次打开时关掉'(p) {
    const r = await p.evaluate(async () => {
      window.__refTabs.add(77);
      window.__wcStore['stripe-ref-tab'] = 77;
      await closeOrphanTab();
      return { removed: [...window.__removedTabs], owned: window.__wcStore['stripe-ref-tab'] ?? null };
    });
    return [r.removed.includes(77) && r.owned === null, r];
  },
  async '#8 同一个侧边栏开着跨过 30 天：自动更新一次'(p) {
    await p.evaluate(() => window.__seedRefCache(5));
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done');
    const before = await state(p);
    await p.evaluate(() => { const c = window.__wcStore['stripe-ref-v1']; c.at = Date.now() - 31 * 86400000; R.at = c.at; render(); });
    await until(p, () => (window.__refCreatedIds || []).length === 1 && R.status === 'done' && !refJob);
    const s = await state(p);
    return [before.created.length === 0, s.n === 972 && s.prevAt != null, s];
  },
  async '满 30 天前不动：缓存 29 天'(p) {
    await p.evaluate(() => window.__seedRefCache(29));
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done');
    await p.waitForTimeout(1500);
    const s = await state(p);
    return [s.created.length === 0 && s.n === 888, s];
  },
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  let fail = 0;
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
      const p = await browser.newPage({ viewport: { width: 380, height: 760 } });
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(URL);
      try {
        const res = await run(p);
        const detail = res.pop();
        const ok = res.every(Boolean) && !errs.length;
        if (!ok) fail++;
        console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(detail), errs.length ? 'JS 错误：' + errs.join(' | ') : '');
      } catch (e) {
        fail++;
        console.log('FAIL', name, e.message.split('\n')[0], JSON.stringify(await state(p).catch(() => null)), errs.join(' | '));
      }
      await p.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  process.exitCode = fail ? 1 : 0;
})();
