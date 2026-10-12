// 新进热词：在关键词表里给 KD=0 且「28 天流量 ÷ 平均体量」> 5 的行加橙框，> 20 加红框；
// 并给侧边栏提供「读本页 / 下一页 / 跳页」，侧边栏据此按当前排序收集前 N 条。重复注入不会重复初始化。
(() => {
  const VERSION = 5;  // 旧版插件注入的脚本没有 scan/next/goto：版本不对就换掉
  if (window.__pkHot && window.__pkHot.version === VERSION) return;
  if (window.__pkHot && window.__pkHot.stop) { try { window.__pkHot.stop(); } catch { /* 旧版本 */ } }

  const ORANGE = 5;
  const RED = 20;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => norm(el && el.innerText);
  const mult = (u) => ({ k: 1e3, m: 1e6, b: 1e9 }[(u || '').toLowerCase()] || 1);

  // '2.4K' → {lo:2400, hi:2400}；'< 50' → {lo:0, hi:50, lt:true}；'-' → null
  function num(s) {
    s = norm(s).replace(/,/g, '');
    let m = s.match(/^<\s*([\d.]+)\s*([KMB]?)$/i);
    if (m) return { lo: 0, hi: +m[1] * mult(m[2]), lt: true };
    m = s.match(/^([\d.]+)\s*([KMB]?)$/i);
    if (m) { const v = +m[1] * mult(m[2]); return { lo: v, hi: v }; }
    return null;
  }

  // 表里没有 KD 时显示「-」，按 0 算；N/A 之类认不出的不算 0
  function kdZero(s) {
    s = norm(s);
    if (s === '' || /^[-–—]$/.test(s)) return true;
    return /^\d+(\.\d+)?$/.test(s) && +s === 0;
  }

  // 按表头文字找列；Ant Design 表格可能把表头和表体拆成两个 <table>，所以按 .ant-table 容器找
  function findTable() {
    const boxes = [...document.querySelectorAll('.ant-table')];
    if (!boxes.length) boxes.push(...document.querySelectorAll('table'));
    for (const box of boxes) {
      const headRow = box.querySelector('thead tr:last-child');
      if (!headRow) continue;
      const col = {};
      let sort = '';
      let x = 0;
      for (const th of headRow.children) {
        const t = text(th);
        if (/^关键词/.test(t)) col.kw = x;
        else if (/^KD$/i.test(t)) col.kd = x;
        else if (/^28\s*天流量/.test(t)) col.t = x;
        else if (/^平均体量/.test(t)) col.v = x;
        else if (/^热门网址/.test(t)) col.url = x;  // 可选列，导出用
        const dir = th.getAttribute('aria-sort');
        if (dir === 'ascending' || dir === 'descending') sort = `${t} ${dir === 'descending' ? '降序' : '升序'}`;
        x += th.colSpan || 1;
      }
      if ([col.kw, col.kd, col.t, col.v].some((v) => v === undefined)) continue;
      let rows = [...box.querySelectorAll('tbody tr.ant-table-row')];
      if (!rows.length) rows = [...box.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td'));
      const wrap = box.closest('.ant-table-wrapper') || box;
      return { col, rows, sort, loading: !!wrap.querySelector('.ant-spin-spinning') };
    }
    return null;
  }

  function cellAt(tr, idx) {
    let x = 0;
    for (const td of tr.children) {
      if (x === idx) return td;
      x += td.colSpan || 1;
      if (x > idx) return null;
    }
    return null;
  }

  // 热门网址：格子里有指向完整网址的链接就用链接，否则用文字
  function topUrl(td) {
    if (!td) return '';
    const a = [...td.querySelectorAll('a[href]')].find((x) => /^https?:/.test(x.href));
    return a ? a.href : text(td);
  }

  // 本页符合规则的行，按表里的顺序
  function hotRows(tb) {
    const out = [];
    tb.rows.forEach((tr, i) => {
      const kd = text(cellAt(tr, tb.col.kd));
      const tRaw = text(cellAt(tr, tb.col.t));
      const vRaw = text(cellAt(tr, tb.col.v));
      const t = num(tRaw);
      const v = num(vRaw);
      if (!kdZero(kd) || !t || !v || !v.hi) return;
      // 「< 50」之类只知道上限：取倍数的下限，确定超过阈值才标
      const ratio = t.lo / v.hi;
      if (!(ratio > ORANGE)) return;
      out.push({ tr, i, kw: text(cellAt(tr, tb.col.kw)), kd, t: tRaw, v: vRaw, ratio, ge: !!v.lt, red: ratio > RED,
        url: tb.col.url === undefined ? '' : topUrl(cellAt(tr, tb.col.url)) });
    });
    return out;
  }

  // ---------- 分页 ----------

  // { cur, total }：sim 用的是简洁分页（输入框 + 「/266」），普通分页取高亮的页码
  function pager() {
    const li = document.querySelector('.ant-pagination li[title*="/"]');
    const m = li && li.title.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) return { cur: +m[1], total: +m[2] };
    const active = document.querySelector('.ant-pagination-item-active');
    const items = [...document.querySelectorAll('.ant-pagination-item')].map((e) => +e.title || +text(e)).filter(Boolean);
    return active ? { cur: +active.title || +text(active), total: Math.max(0, ...items) } : { cur: 1, total: 1 };
  }

  function nextEnabled() {
    const li = document.querySelector('.ant-pagination-next');
    return !!li && !li.classList.contains('ant-pagination-disabled') && !li.querySelector('button[disabled]');
  }

  const firstKw = () => {
    const tb = findTable();
    return tb && tb.rows.length ? text(cellAt(tb.rows[0], tb.col.kw)) : '';
  };

  // 等表格换成另一页的数据：靠 DOM 变化触发判断，不靠定时轮询——
  // 标签页在后台久了，页面里的定时器会被 Chrome 限流到每分钟一次。超时由侧边栏把关。
  function waitForNewPage(prevFirst) {
    const ready = () => {
      const tb = findTable();
      if (!tb || tb.loading || !tb.rows.length) return false;
      const f = text(cellAt(tb.rows[0], tb.col.kw));
      return !!f && f !== prevFirst;  // React 一次提交换完整页，首行变了就是整页换好了
    };
    return new Promise((resolve) => {
      if (ready()) return resolve(true);
      const ob = new MutationObserver(() => {
        if (ready()) { ob.disconnect(); resolve(true); }
      });
      ob.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    });
  }

  async function goToPage(n) {
    if (pager().cur === n) return true;
    const before = firstKw();
    const input = document.querySelector('.ant-pagination-simple-pager input');
    if (input) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(input, String(n));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      for (const type of ['keydown', 'keyup']) {
        input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
    } else {
      const item = document.querySelector(`.ant-pagination-item-${n}`);
      if (!item) return false;
      item.click();
    }
    return waitForNewPage(before);
  }

  // ---------- 标框 ----------

  function ensureStyle() {
    if (document.getElementById('pk-hot-style')) return;
    const st = document.createElement('style');
    st.id = 'pk-hot-style';
    // 背景用不透明色：固定列是 sticky，半透明会透出横向滚动下去的内容
    st.textContent = ['orange:#f59e0b:#fff7ed', 'red:#ef4444:#fef2f2'].map((s) => {
      const [name, c, bg] = s.split(':');
      return `tr.pk-hot-${name} > td { background: ${bg} !important; box-shadow: inset 0 2px 0 ${c}, inset 0 -2px 0 ${c} !important; }
tr.pk-hot-${name} > td:first-child { box-shadow: inset 2px 0 0 ${c}, inset 0 2px 0 ${c}, inset 0 -2px 0 ${c} !important; }
tr.pk-hot-${name} > td:last-child { box-shadow: inset -2px 0 0 ${c}, inset 0 2px 0 ${c}, inset 0 -2px 0 ${c} !important; }`;
    }).join('\n') ;
    document.head.appendChild(st);
  }

  function clearMarks() {
    for (const tr of document.querySelectorAll('tr.pk-hot-red, tr.pk-hot-orange, tr[data-pk-hot]')) {
      tr.classList.remove('pk-hot-red', 'pk-hot-orange');
      delete tr.dataset.pkHot;
    }
  }

  function mark() {
    clearMarks();
    const tb = findTable();
    if (!tb) return null;
    ensureStyle();
    for (const x of hotRows(tb)) {
      x.tr.classList.add(x.red ? 'pk-hot-red' : 'pk-hot-orange');
      x.tr.dataset.pkHot = String(x.i);
    }
    return tb;
  }

  let observer = null;
  let timer = null;
  let firstAt = 0;  // 这一轮第一次变化的时间

  // 翻页、排序后重标。只监听节点增删和文字变化；我们自己改的是 class，不会触发自己。
  // 停 400ms 再重标；页面一直在变（轮播、计时器）时最多拖 1.5s 也要标一次
  function follow() {
    if (observer) return;
    observer = new MutationObserver(() => {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(() => {
        firstAt = 0;
        mark();
      }, Math.max(0, Math.min(400, firstAt + 1500 - now)));
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ---------- 给侧边栏调用的动作（翻页节奏、超时、停止都由侧边栏控制） ----------

  const NO_TABLE = '当前页面没找到同时有「关键词」「KD」「28 天流量」「平均体量」四列的表格。';

  // ctx：哪张表。sim 翻页不改网址；换域名、筛选或排序才算另一张表
  function scan() {
    const tb = findTable();
    if (!tb) return { error: NO_TABLE };
    if (tb.loading || !tb.rows.length) return { loading: true };  // 加载中的旧行 / 空表不算数据，侧边栏会等一下再读
    const { cur, total } = pager();
    return {
      ctx: location.href + '|' + tb.sort, url: location.href, sort: tb.sort, cur, total,
      pageSize: tb.rows.length, hasNext: nextEnabled(),
      items: hotRows(tb).map(({ tr, ...x }) => x),
      // 整页每一行的关键词（含没达标的）：存进快照，下次才分得清「新出现」和「新达标」
      all: tb.rows.map((tr) => text(cellAt(tr, tb.col.kw))),
    };
  }

  async function next() {
    if (!nextEnabled()) return false;
    const before = firstKw();
    document.querySelector('.ant-pagination-next').click();
    return waitForNewPage(before);
  }

  window.__pkHot = {
    version: VERSION,
    // 标框并跟随翻页、排序自动重标
    start() {
      if (!mark()) return { error: NO_TABLE };
      follow();
      return scan();
    },
    scan,
    next,
    goto: goToPage,
    stop() {
      if (observer) observer.disconnect();
      observer = null;
      clearTimeout(timer);
      firstAt = 0;
      clearMarks();
      return true;
    },
  };
})();
