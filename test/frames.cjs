// 把侧边栏各视图的真实状态截成图（亮色 / 暗色各一套），给设计评审用。
// 用法：node test/frames.cjs [输出目录]（默认 design/frames/）；ONLY=名字片段 只截那几张。用的是本机别的项目装好的 Playwright。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/wy/cafe/pdftojpg/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'design/frames'));
const PORT = 4993;
const URL = `http://127.0.0.1:${PORT}/test/panel-harness4.html`;
const W = 380, H = 760;  // Chrome 侧边栏常见宽度

const until = (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const text = (s) => `document.querySelector('#view').innerText.includes(${JSON.stringify(s)})`;

// 每个状态：怎么走到那一步。页面加载时默认在「新进热词」（测试页 2 把当前标签页设成 sim 关键词表）
const FRAMES = [
  ['1-domains-done', async (p) => {
    await p.evaluate(() => { window.__tabUrl = 'https://sim.3ue.co/#/digitalsuite/acquisition/keyword/organic/search/999/28d/keywordAnalysis_2?keyword=pdf'; });
    await p.click('#tab-domains');
    await p.click('[data-act=scan]');
    await until(p, () => !document.querySelector('#view').innerText.includes('查注册时间'), null);
    await until(p, () => document.querySelectorAll('.drow').length > 10 && !/正在|查询中/.test(document.querySelector('.status')?.innerText || ''), null);
  }],
  ['1b-domains-compare', async (p) => {
    // 预置一份 7 天前的扫描：去掉几个域名（→ 首次出现）、多一个这次没有的（→ 消失）；大部分域名早就见过，少数今天才见（→ 从没见过）
    await p.evaluate(() => {
      const url = 'https://sim.3ue.co/#/digitalsuite/acquisition/keyword/organic/search/999/28d/keywordAnalysis_2?keyword=pdf';
      window.__tabUrl = url;
      const t7 = Math.floor(Date.now() / 1000) - 7 * 86400;
      const keep = CANNED.items.filter((x) => !x.self && !['my99ai.com', 'skills.rest', 'blazedocs.io'].includes(x.domain));
      window.__store.snaps.push({ id: 900, kind: 'domains', key: pageKey(url), family: null, label: 'x', created_at: t7,
        day: new Date(t7 * 1000).toLocaleDateString('sv'), n: keep.length + 1, items: [...keep.map((x) => ({ d: x.domain })), { d: 'gone-example.com' }] });
      for (const x of keep) window.__store.seen[x.domain] = t7;
    });
    await p.click('#tab-domains');
    await p.click('[data-act=scan]');
    await until(p, () => document.querySelectorAll('.drow').length > 10 && !/查询中/.test(document.querySelector('.status')?.innerText || ''), null);
  }],
  ['2-domains-notsim', async (p) => {
    await p.evaluate(() => { window.__tabUrl = 'https://www.google.com/search?q=pdf'; });
    await p.click('#tab-domains');
    await p.click('[data-act=scan]').catch(() => {});
    await until(p, text('只在 sim.3ue.co 上用'));
  }],
  ['3-hot-idle', async (p) => { await until(p, () => !!document.querySelector('[data-act=collect]'), null); }],
  ['4-hot-running', async (p) => {
    await until(p, () => !!document.querySelector('[data-act=collect]'), null);
    await p.click('[data-act=collect]');
    await until(p, () => !!document.querySelector('[data-act=stop]') && document.querySelectorAll('.list .hrow').length > 5, null);
  }],
  ['5-hot-done', async (p) => {
    await until(p, () => !!document.querySelector('[data-act=collect]'), null);
    await p.click('[data-act=collect]');
    await until(p, () => !!document.querySelector('[data-act=export]:not([disabled])') && !document.querySelector('[data-act=stop]'), null, 60000);
  }],
  ['6-words-done', async (p) => {
    await p.click('#tab-words');
    await until(p, () => document.querySelectorAll('#wlist .hrow').length > 0, null);
  }],
  ['7-refs-loading', async (p) => {
    await p.click('#tab-refs');
    await until(p, text('第 3 / 10 页'));
  }],
  ['8-refs-done', async (p) => {
    await p.evaluate(() => window.__seedRefCache(31));
    await p.click('#tab-refs');
    await until(p, () => R.status === 'done' && !refJob && !!document.querySelector('#rlist .hrow'), null, 90000);
  }],
  ['9-refs-error', async (p) => {
    await p.evaluate(() => { window.__refBroken = true; });
    await p.click('#tab-refs');
    await until(p, text('没读到 Stripe 引荐网站'));
  }],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const only = process.env.ONLY;
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: scheme, deviceScaleFactor: 2 });
      for (const [name, go] of FRAMES) {
        if (only && !name.includes(only)) continue;
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(e.message));
        await p.goto(URL);
        try {
          await go(p);
          await p.waitForTimeout(150);
          await p.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
          console.log('ok  ', name, scheme, errs.length ? 'JS 错误：' + errs.join(' | ') : '');
        } catch (e) {
          console.log('FAIL', name, scheme, e.message.split('\n')[0], errs.join(' | '));
        }
        await p.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
})();
