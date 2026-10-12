// 找站：读 sim 上 checkout.stripe.com 的「外链 → 引荐网站」表（Similarweb 自己的分栏表格，不是 Ant 表格）。
// 给侧边栏提供「读本页 / 下一页 / 回第 1 页 / 取消等待」；翻页节奏、超时由侧边栏控制。重复注入不会重复初始化。
(() => {
  const VERSION = 2;
  if (window.__pkRef && window.__pkRef.version === VERSION) return;
  window.__pkRef?.cancel?.();  // 旧版本还在等的先断开

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // 表头和数据是两组分栏：表头 4 栏在 wrapper 外（域 (974) / 行业 / 全球排名 / 流量份额），数据 4 栏在 wrapper 里，
  // 每栏一格一行（最后一格是拖宽度的边框）。按表头名字找栏，找不到就按默认顺序
  const NAMES = { d: /^域/, industry: /^行业/, grank: /^全球排名/, share: /^流量份额/ };
  function columns() {
    const wrap = document.querySelector('.swReactTable-wrapper');
    if (!wrap) return null;
    const data = [...wrap.querySelectorAll('.swReactTable-column')];
    if (data.length < 4) return null;
    const heads = [...document.querySelectorAll('.swReactTable-column')].filter((c) => !wrap.contains(c)).map((c) => norm(c.children[0]?.innerText));
    const at = {};
    Object.entries(NAMES).forEach(([k, re], i) => { const j = heads.findIndex((h) => re.test(h)); at[k] = data[j >= 0 && heads.length === data.length ? j : i]; });
    return at;
  }
  const cells = (col) => [...col.children].filter((e) => e.classList.contains('swReactTableCell'));

  // 表格底部：|‹ ‹ [页码] out of N › ›|
  function pager() {
    const inp = [...document.querySelectorAll('input')].find((i) => /out of\s*\d+/.test(i.closest('div')?.parentElement?.textContent || ''));
    if (!inp) return null;
    const bar = inp.parentElement.parentElement.parentElement;
    const m = bar.textContent.match(/out of\s*(\d+)/);
    return { inp, cur: +inp.value || 1, total: m ? +m[1] : 1, arrows: [...bar.querySelectorAll('svg')].map((s) => s.closest('button,[role=button],div')) };
  }

  const firstDomain = () => document.querySelector('.swReactTable-wrapper .swReactTable-column a.cell-clickable')?.textContent.trim() || '';

  function scan() {
    const cols = columns();
    const p = pager();
    if (!cols || !firstDomain() || !p) return { loading: true };
    const [cInd, cRank, cShare] = [cells(cols.industry), cells(cols.grank), cells(cols.share)];
    const rows = [];
    cells(cols.d).forEach((cell, i) => {
      const a = cell.querySelector('a.cell-clickable');
      if (!a) return;
      rows.push({ d: a.textContent.trim().toLowerCase(), industry: norm(cInd[i]?.innerText),
        grank: norm(cRank[i]?.innerText), share: norm(cShare[i]?.innerText), sub: +((cell.innerText.match(/\((\d+)\)\s*$/) || [])[1] || 0) });
    });
    return {
      rows, cur: p.cur, pages: p.total, href: location.href,
      total: +((document.body.innerText.match(/域\s*\(([\d,]+)\)/) || [])[1] || '').replace(/,/g, '') || null,
    };
  }

  // 等表格换成另一页：翻页时整张表连同底下的页码栏会先拆掉再画，
  // 首行域名变了（且不为空）、页码栏也画回来了，才算新的一页。
  // 页面里不用定时器（后台标签页会被限流）：超时、停止由侧边栏判断，再调 cancel() 断开还在等的观察器
  const waiting = new Set();
  const settle = (w, v) => { w.ob.disconnect(); waiting.delete(w); w.resolve(v); };
  function cancel() { for (const w of [...waiting]) settle(w, false); return true; }
  function waitForNewPage(prevFirst) {
    const ready = () => { const f = firstDomain(); return !!f && f !== prevFirst && !!columns() && !!pager(); };
    return new Promise((resolve) => {
      if (ready()) return resolve(true);
      const w = { resolve, ob: new MutationObserver(() => { if (ready()) settle(w, true); }) };
      waiting.add(w);
      w.ob.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }

  async function next() {
    cancel();
    const p = pager();
    if (!p || p.cur >= p.total || !p.arrows[2]) return false;
    const before = firstDomain();
    p.arrows[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return waitForNewPage(before);
  }

  async function first() {
    cancel();
    const p = pager();
    if (!p || p.cur === 1) return true;
    const before = firstDomain();
    p.arrows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return waitForNewPage(before);
  }

  window.__pkRef = { version: VERSION, scan, next, first, cancel };
})();
