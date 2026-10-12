// 「找站」生命周期场景测试（对应 Codex 10-12 两轮审查）：node test/refs-check.cjs（ONLY=名字片段 只跑那几个）
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
  saved: window.__wcStore['stripe-ref-v1']?.items?.length ?? null,
  prevAt: window.__wcStore['stripe-ref-v1']?.prev?.at ?? null,
}));

const CASES = {
  async '正常拉取：读满、关掉自己开的后台标签页'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob);
    const s = await state(p);
    return [s.n === 972 && s.saved === 972, s.created.length === 1 && s.removed.includes(s.created[0]), s];
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
    // 刚收完第 2 页、还在翻页间隔里就跳走（Codex 第二轮 #7：以前会先误翻一次新表）
    const flipsAt = await p.evaluate(() => { const w = window.__refFrame.contentWindow; w.__href = w.__href.replace('checkout.stripe.com', 'other.com'); return w.__flips; });
    await until(p, () => !refJob && R.status !== 'loading');
    await p.waitForTimeout(1500);
    const flipsLater = await p.evaluate(() => window.__refFrame.contentWindow.__flips);
    const s = await state(p);
    return [/跳到别的页面/.test(s.err || ''), s.saved === null, s.created.length === 0, flipsLater === flipsAt, { ...s, flipsAt, flipsLater }];
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
  async '二轮#1 用户切到我们开的后台页看过：读完不关'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.page >= 2);
    await p.evaluate(() => window.__onActivated.forEach((f) => f({ tabId: refJob.tabId })));
    await until(p, () => R.status === 'done' && !refJob);
    const s = await state(p);
    return [s.n === 972, !s.removed.includes(s.created[0]), s];
  },
  async '二轮#5 写缓存时点停止：不生效，界面和存着的一致'(p) {
    await p.evaluate(() => { window.__slowSet = 1500; });
    await p.click('#tab-refs');
    await until(p, () => refJob?.committing);
    await p.evaluate(() => stopRefs());
    await until(p, () => !refJob && R.status !== 'loading');
    const s = await state(p);
    return [s.status === 'done' && s.n === 972 && s.saved === 972, s];
  },
  async '二轮#6 停掉还在加载的用户页：这一轮马上退出，不卡下一轮'(p) {
    await p.evaluate(() => { window.__refOpen = true; window.__refLoadDelay = 1e7; window.__refLoad(); });
    await p.click('#tab-refs');
    await p.waitForTimeout(2500);
    const ms = await p.evaluate(async () => { const job = refJob; const t0 = Date.now(); stopRefs(); await job.finished; return Date.now() - t0; });
    const s = await state(p);
    return [ms < 3000, s.status === 'stopped', { ...s, ms }];
  },
  async '二轮#8 拉到新的一份后又过了 30 天：再自动更新一次'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob);
    await p.evaluate(() => { const c = window.__wcStore['stripe-ref-v1']; c.at = Date.now() - 31 * 86400000; R.at = c.at; render(); });
    await until(p, () => (window.__refCreatedIds || []).length === 2 && R.status === 'done' && !refJob);
    const s = await state(p);
    return [s.n === 972 && s.prevAt != null, s];
  },
  async '二轮#9 后台拉取的进度重画：搜索框不丢焦点、字不丢'(p) {
    await p.evaluate(() => window.__seedRefCache(31));
    await p.click('#tab-refs');
    await until(p, () => R.status === 'loading' && !!document.querySelector('[data-act=r-search]'));
    await p.click('[data-act=r-search]');
    await p.keyboard.type('site1');
    const pageAt = await p.evaluate(() => R.page);
    await until(p, (n) => R.page >= n + 2, pageAt);
    const r = await p.evaluate(() => ({ focused: document.activeElement?.dataset?.act, value: document.activeElement?.value }));
    return [r.focused === 'r-search' && r.value === 'site1', r];
  },
  async '三轮#1 停止后马上重拉：旧一轮收拾时用户切到它的页，不关'(p) {
    await p.evaluate(() => { window.__slowCancel = 600; });
    await p.click('#tab-refs');
    await until(p, () => R.page >= 2);
    const oldTab = await p.evaluate(() => { const t = refJob.tabId; stopRefs(); loadRefs({ force: true }); window.__onActivated.forEach((f) => f({ tabId: t })); return t; });
    await until(p, () => R.status === 'done' && !refJob && (window.__refCreatedIds || []).length === 2, null, 90000);
    const s = await state(p);
    return [!s.removed.includes(oldTab), s.n === 972, { ...s, oldTab }];
  },
  async '三轮#2 过期缓存手动重拉后停止：不再自动开一轮'(p) {
    await p.evaluate(() => window.__seedRefCache(5));
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done');
    await p.evaluate(() => { const c = window.__wcStore['stripe-ref-v1']; c.at = Date.now() - 31 * 86400000; R.at = c.at; loadRefs({ force: true }); });
    await until(p, () => R.page >= 2);
    await p.evaluate(() => stopRefs());
    await until(p, () => !refJob && R.status === 'done');
    await p.waitForTimeout(3000);
    const s = await state(p);
    return [s.created.length === 1, s.n === 888, s];
  },
  async '三轮#3 停止时页面注入还卡着：这一轮马上退出'(p) {
    await p.evaluate(() => { window.__refOpen = true; window.__refLoadDelay = 10; window.__refLoad(); window.__hangInject = true; });
    await until(p, () => !!window.__refFrame.contentWindow.document.querySelector('.swReactTable-wrapper'));
    await p.click('#tab-refs');
    await p.waitForTimeout(1500);
    const ms = await p.evaluate(async () => { const job = refJob; const t0 = Date.now(); stopRefs(); await job.finished; return Date.now() - t0; });
    const s = await state(p);
    return [ms < 3000, s.status === 'stopped', { ...s, ms }];
  },
  async '域龄：查过的先出、没查过的补查，1 年内注册筛选 + 复制'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob && R.regStatus === 'done', null, 120000);
    await p.waitForTimeout(600);  // 等最后一次就地刷新
    const r = await p.evaluate(async () => {
      const young = R.items.filter(refYoung).length;
      const pills = document.querySelectorAll('#rlist .agecell .age, #rlist .agecell .tag').length, all = R.items.length;
      const hosted = [...document.querySelectorAll('#rlist .agecell .tag')].map((t) => t.closest('.hrow').querySelector('.dname a').textContent);
      const chip = document.querySelector('[data-act=r-young]').textContent;
      const look = new Set(Object.values(R.dom).filter(Boolean).map((m) => m.d)).size;
      document.querySelector('[data-act=r-young]').click();
      const rows = document.querySelectorAll('#rlist .hrow').length;
      const copyLabel = document.querySelector('[data-act=r-copy]').textContent;
      document.querySelector('[data-act=r-copy]').click();
      await new Promise((res) => setTimeout(res, 100));
      const lines = (window.__copied || '').split('\n');
      return { young, pills, all, hosted, chip, look, rows, copyLabel, lines: lines.length, head: lines[0], cols: lines[1]?.split('\t').length, sample: lines[1], ...window.__lookups };
    });
    return [r.young > 0 && r.chip === `1 年内注册 ${r.young}`, r.pills === r.all && JSON.stringify(r.hosted) === '["pdf-merge-demo.vercel.app"]', r.rows === r.young && r.copyLabel === `复制 ${r.young} 个`,
      r.lines === r.young + 1 && r.cols === 8, r.cachedOnly === Math.ceil(r.look / 20) && r.single > 0, r];
  },
  async '热门网址：每行显示站名，点开是它的新进关键词页'(p) {
    await until(p, () => !!document.querySelector('[data-act=collect]'));
    await p.click('[data-act=collect]');
    await until(p, () => !document.querySelector('[data-act=stop]') && !!document.querySelector('[data-act=export]'));
    const r = await p.evaluate(() => [...document.querySelectorAll('.list .hrow .topurl')].slice(0, 6).map((a) => ({ t: a.textContent, href: a.getAttribute('href') })));
    const okText = r.length === 6 && r.every((x) => !/^www\./.test(x.t) && /\./.test(x.t));
    // 太长的站名会省中间（「pdf-page-a….vercel.app」）：链接里的是完整站名，显示的字对得上头尾就行
    const keyOf = (href) => decodeURIComponent((href.match(/[?&]key=([^&]+)/) || [])[1] || '');
    const okHref = r.every((x) => x.href.includes('website-keyword-v2') &&
      (keyOf(x.href) === x.t || (x.t.includes('…') && keyOf(x.href).startsWith(x.t.split('…')[0]) && keyOf(x.href).endsWith(x.t.split('…')[1]))));
    return [okText, okHref, r];
  },
  async '查域名：组合 × 7 个后缀，注册日从近到远、没注册的放最后'(p) {
    const forms = await p.evaluate(() => ({ multi: nameForms('PDF to JPG'), one: nameForms('jpg'), dom: nameForms('pdftojpg.com'),
      accent: nameForms('café menu'), cjk: nameForms('图片转pdf'), forx: nameForms('tools for seo') }));
    await p.click('#tab-names');
    await p.fill('[data-act=n-input]', 'pdf to jpg');
    await p.press('[data-act=n-input]', 'Enter');
    await until(p, () => N.status === 'done');
    const r = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('.list .drow')].map((el) => ({ d: el.querySelector('.dname').textContent.trim(), reg: el.querySelector('.c-reg')?.textContent || '', miss: el.querySelector('.c-miss')?.textContent || '' }));
      const regs = rows.filter((x) => x.reg).map((x) => x.reg);
      const firstFree = rows.findIndex((x) => x.miss === '未注册');
      return { n: rows.length, sorted: regs.every((d, i) => i === 0 || regs[i - 1] >= d), freeLast: firstFree > 0 && rows.slice(firstFree).every((x) => x.miss === '未注册'),
        free: rows.filter((x) => x.miss === '未注册').length, tlds: [...new Set(rows.map((x) => x.d.split('.').pop()))].join(','), focus: document.activeElement?.dataset?.act };
    });
    const okForms = JSON.stringify(forms.multi) === '["pdftojpg","pdf-to-jpg","pdfjpg","pdf-jpg","pdf2jpg"]' && JSON.stringify(forms.one) === '["jpg"]' &&
      JSON.stringify(forms.dom) === '["pdftojpg"]' && JSON.stringify(forms.accent) === '["cafemenu","cafe-menu"]' && forms.cjk.length === 0 &&
      JSON.stringify(forms.forx) === '["toolsforseo","tools-for-seo","toolsseo","tools-seo","tools4seo"]';
    return [okForms, r.n === 35 && r.tlds.split(',').sort().join(',') === 'ai,app,com,io,net,org,video', r.sorted && r.freeLast && r.free > 0, { forms, ...r }];
  },
  async '四轮#5/#6 服务没开 → 开了以后补查；查失败的下一轮重查'(p) {
    await p.evaluate(() => { window.__serviceDown = true; });
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob && R.regStatus === 'error');
    // 服务开了，但单个查询全报 500：这一轮做完，但不算查完
    await p.evaluate(() => { window.__serviceDown = false; window.__lookupFail = true; R.regErrAt = 0; render(); });
    await until(p, () => R.regStatus === 'done' && R.regRunFor === R.at);
    const mid = await p.evaluate(() => ({ regFor: R.regFor === R.at, failed: Object.values(R.reg).filter((r) => !r.reg).length }));
    // 一分钟后（这里直接把时间拨过去）再打开：失败的那些重新查到
    await p.evaluate(() => { window.__lookupFail = false; R.regErrAt = 0; render(); });
    await until(p, () => R.regFor === R.at && R.regStatus === 'done');
    const end = await p.evaluate(() => ({ missing: R.items.filter((x) => R.dom[x.d] && !R.dom[x.d].hosted && !R.reg[R.dom[x.d].d]?.reg).length }));
    return [!mid.regFor && mid.failed > 0, end.missing === 0, { mid, end }];
  },
  async '四轮#3 刷新后旧一轮的失败不覆盖新一轮'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob && R.regStatus === 'running');
    const r = await p.evaluate(async () => {
      window.__lookupFail = true; window.__lookupDelay = 300;
      const d = Object.values(R.dom).find((m) => m && !m.hosted && !R.reg[m.d])?.d;
      R.at = R.at + 1;  // 换了一份（像刷新那样）：旧的一轮之后的结果都不该再写
      R.reg[d] = { reg: '2020-01-02', source: 'RDAP' };
      await new Promise((res) => setTimeout(res, 1500));
      return { kept: R.reg[d]?.reg, d };
    });
    return [r.kept === '2020-01-02', r];
  },
  async '四轮#7/#9 主机名规范化、复制时清理单元格'(p) {
    const r = await p.evaluate(() => ({ a: normHost('Café.com.'), b: normHost('APP.MailerFind.com'), c: tsvCell('=HYPERLINK("x")'), d: tsvCell('a\tb\nc'), e: tsvCell('-5'), f: tsvCell('ok') }));
    return [r.a === 'xn--caf-dma.com' && r.b === 'app.mailerfind.com', r.c === `'=HYPERLINK("x")` && r.d === 'a b c' && r.e === "'-5" && r.f === 'ok', r];
  },
  async '四轮#8 超过 3000 个主机名分批归并'(p) {
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob);
    await p.evaluate(() => { R.items = Array.from({ length: 3500 }, (_, i) => ({ d: `site${i}.com`, industry: '', grank: '-', share: '0.01%', rank: i + 1 })); R.at = R.at + 1; window.__normalizeCalls = 0; window.__normalizeMax = 0; lookupRefAges(); });
    await until(p, () => R.regStatus === 'done' && R.regFor === R.at, null, 120000);
    const r = await p.evaluate(() => ({ calls: window.__normalizeCalls, max: window.__normalizeMax, mapped: R.items.filter((x) => R.dom[x.d]).length }));
    return [r.calls === 2 && r.max === 3000 && r.mapped === 3500, r];
  },
  async '四轮#4 查域名查询中打字：字不被冲掉'(p) {
    await p.evaluate(() => { window.__lookupDelay = 150; });
    await p.click('#tab-names');
    await p.fill('[data-act=n-input]', 'pdf to jpg');
    await p.press('[data-act=n-input]', 'Enter');
    await until(p, () => N.status === 'running' && N.done > 0);
    await p.fill('[data-act=n-input]', 'merge pdf');
    await until(p, (n) => N.done >= n + 3, await p.evaluate(() => N.done));
    const r = await p.evaluate(() => ({ value: document.querySelector('[data-act=n-input]').value, q: N.q }));
    return [r.value === 'merge pdf' && r.q === 'pdf to jpg', r];
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
