// 浏览助手侧边栏。界面按画布「浏览助手侧边栏设计」A2 行；对比规则见 README「和上次比」。
const API = 'http://127.0.0.1:8793';
const SERVICE_CMD = 'launchctl kickstart -k gui/$(id -u)/com.wy.page-helper';
const TARGET = 100;     // 新进热词最多收集多少条（用户 10-12 由 500 改成 100）
const PAGE_CAP = 50;    // 一轮最多翻多少页，不够再点「再翻 50 页」
const PAGE_GAP = 600;   // 翻页间隔（毫秒），别连续猛翻
const PAGE_TIMEOUT = 40000;

const $ = (s) => document.querySelector(s);
const view = $('#view');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => false)]);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 链接 ----------

const SIM = 'https://sim.3ue.co/#';
// 关键词分析页（SERP 市场参与者），999 = 全球
const kwUrl = (kw) => `${SIM}/digitalsuite/acquisition/keyword/organic/search/999/28d/keywordAnalysis_2` +
  `?keyword=${encodeURIComponent(kw)}&mtd=false&webSource=Total&selectedPageTab=Organic`;
// 域名的新进非品牌关键词页
const domainUrl = (d) => `${SIM}/organicsearch/pageAnalysis/website-keyword-v2/*/999/28d?key=${encodeURIComponent(d)}` +
  `&pageFilter=${encodeURIComponent(JSON.stringify([{ url: d, searchType: 'domain' }]))}` +
  '&webSource=Total&IncludeBranded=false&IncludeNoneBranded=true&Change=New&selectedPageTab=Organic&comparedDuration=';
// Google Trends 近 1 个月全球，和基准词 gpts 对比（基准不能动）。
// 格式照 Trends 自己的地址：词先编码一次，整个 q 再编码一次（空格 → %2520）
const TRENDS_BASE = 'gpts';
const trendsUrl = (kw) => 'https://trends.google.com/explore?geo=Worldwide' +
  `&q=${encodeURIComponent(encodeURIComponent(kw) + ',' + TRENDS_BASE)}&date=today%201-m`;

// ---------- 通用 ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
// 插件只在 sim.3ue.co 上采集数据（manifest 的 host_permissions 也只给了这个域名，别的网站连网址都读不到）
const isSim = (t) => !!t && /^https:\/\/sim\.3ue\.co\//.test(t.url || '');
const isKeywordPage = (url) => /sim\.3ue\.co\/#\/organicsearch\/pageAnalysis\/website-keyword/.test(url || '');
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
// sim 关键词页上显示的是在看哪个域名
function simKey(url) {
  try {
    const h = new URL(url).hash;
    return new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('key') || '';
  } catch { return ''; }
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Page-Helper': '1' },
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('本机服务没有响应'), { down: true });
  }
  if (!r.ok) throw new Error(`本机服务出错：${path} HTTP ${r.status}`);
  return r.json();
}

const today = () => new Date().toLocaleDateString('sv');  // YYYY-MM-DD，本地时区
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
function dayLabel(snap) {
  const days = Math.round((new Date(today()) - new Date(snap.day)) / 86400000);
  return `${snap.day.slice(5)} · ${days === 1 ? '昨天' : `${days} 天前`}`;
}

// 页面网址归一：去掉 utm 之类跟踪参数；# 只在像路由（#/、#!/）时保留——sim 的页面就在 # 后面
function pageKey(url) {
  try {
    const u = new URL(url);
    const tracking = (k) => /^(utm_|gclid$|fbclid$|msclkid$)/i.test(k);
    for (const k of [...u.searchParams.keys()]) if (tracking(k)) u.searchParams.delete(k);
    if (!/^#!?\//.test(u.hash)) u.hash = '';
    else if (u.hash.includes('?')) {  // 路由式 # 里的查询参数也去掉跟踪参数
      const i = u.hash.indexOf('?');
      const q = new URLSearchParams(u.hash.slice(i + 1));
      for (const k of [...q.keys()]) if (tracking(k)) q.delete(k);
      u.hash = u.hash.slice(0, i) + (q.toString() ? '?' + q : '');
    }
    return u.toString();
  } catch { return url; }
}

// 某张表的快照：基线候选（今天以前的，新→旧；同一天反复查不挤掉上周的）+ 同一网址下别的排序
async function loadSnapshots(kind, key, family) {
  const r = await api('/snapshot/list', { kind, key, family });
  const t = today();
  return { bases: r.snapshots.filter((s) => s.day !== t), others: r.others };
}

const csvCell = (v, guard = false) => {
  let s = String(v ?? '');
  if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s;  // 别让表格软件当公式
  return '"' + s.replace(/"/g, '""') + '"';
};

function download(name, lines) {
  // 带 BOM：Excel 直接双击打开中文不乱码
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const IGNORE_DOMAINS = new Set(['3ue.co', 'similarweb.com']);
const ICON_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M10 14 20 4"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path></svg>';
const ICON_CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';
const ICON_ALERT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6"></path><path d="M12 16.5v.5"></path></svg>';
const ICON_TABLE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M9 9v11"></path></svg>';

const NOT_SIM_CARD = `<div class="list"><section class="card"><h2>只在 sim.3ue.co 上用</h2>
  <p>这个视图读的是当前标签页里 sim.3ue.co 的页面，当前标签页不是 sim。</p>
  <a class="btn primary big ext" href="https://sim.3ue.co/">打开 sim.3ue.co</a>
</section></div>`;

function serviceDownCard(what) {
  return `<section class="card err"><h2>${ICON_ALERT}本机查询服务没有响应</h2>
    <p>${esc(what)}要靠本机服务。在终端运行下面这行，再点「重试」：</p>
    <div class="cmd"><code>${esc(SERVICE_CMD)}</code><button class="btn" type="button" data-act="copy-cmd">复制</button></div>
    <button class="btn primary self-start" type="button" data-act="retry">重新读取</button></section>`;
}

const foldRow = (act, open, text) =>
  `<button class="fold" type="button" data-act="${act}" aria-expanded="${!!open}">${ICON_CHEVRON}${esc(text)}</button>`;

// ---------- 页面状态 ----------

const S = { view: null, tab: null, shown: null, scroll: { domains: 0, hot: 0, words: 0, refs: 0, names: 0 } };

async function refreshContext() {
  S.tab = await activeTab();
  const t = S.tab;
  let label = '不是 sim.3ue.co';
  if (isSim(t)) label = isKeywordPage(t.url) ? `${simKey(t.url) || hostOf(t.url)} · 关键词表` : 'sim.3ue.co';
  $('#ctx').textContent = label;
}

function setView(v) {
  S.view = v;
  for (const t of ['domains', 'hot', 'words', 'refs', 'names']) $(`#tab-${t}`)?.setAttribute('aria-selected', String(v === t));
  render();
}

// 重画会换掉整个列表：先记住各视图滚到哪，画完滚回去（点 Trends 开新标签页、切回来都会重画）
function render() {
  const list = view.querySelector('.list');
  if (list && S.shown) S.scroll[S.shown] = list.scrollTop;
  // 后台任务（收集、拉取）的进度会触发重画：正在打字的输入框画完放回焦点和光标
  const fa = document.activeElement;
  const typing = fa && view.contains(fa) && fa.dataset.act && fa.tagName === 'INPUT' ? { act: fa.dataset.act, a: fa.selectionStart, b: fa.selectionEnd } : null;
  if (S.view === 'domains') renderDomains();
  else if (S.view === 'hot') renderHot();
  else if (S.view === 'words') renderWords();
  else if (S.view === 'refs') renderRefs();
  else if (S.view === 'names') renderNames();
  S.shown = S.view;
  const now = view.querySelector('.list');
  if (now && S.view) now.scrollTop = S.scroll[S.view] || 0;
  if (typing) {
    const el = view.querySelector(`input[data-act="${typing.act}"]`);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(typing.a, typing.b); } catch { /* search 框不支持就算了 */ } }
  }
}
// 新的一轮 / 换了筛选：从顶上看起
const scrollTop = (v) => { S.scroll[v] = 0; const l = view.querySelector('.list'); if (l && S.shown === v) l.scrollTop = 0; };

// ================= 域名注册时间 =================

const D = { run: 0, status: 'idle' };

// 在网页里执行：收集链接里的主机名 + 正文里像域名的文字
function collectHosts() {
  const seen = new Map();
  const add = (h, via) => {
    const k = h.toLowerCase().replace(/\.$/, '') + '|' + via;
    seen.set(k, (seen.get(k) || 0) + 1);
  };
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) add(u.hostname, 'link');
    } catch { /* 坏链接跳过 */ }
  }
  const text = (document.body ? document.body.innerText : '').slice(0, 2000000);
  const re = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})(?![\w-])/gi;
  for (const m of text.matchAll(re)) add(m[0], 'text');
  const hosts = [...seen].map(([k, n]) => {
    const i = k.lastIndexOf('|');
    return { h: k.slice(0, i), via: k.slice(i + 1), n };
  });
  return { pageHost: location.hostname, hosts: hosts.slice(0, 3000) };
}

function ageMonths(reg) {
  const d = new Date(reg + 'T00:00:00Z');
  const now = new Date();
  let m = (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + now.getUTCMonth() - d.getUTCMonth();
  if (now.getUTCDate() < d.getUTCDate()) m--;
  return m;
}
function ageText(reg) {
  const days = Math.floor((Date.now() - new Date(reg + 'T00:00:00Z')) / 86400000);
  if (days < 60) return `${Math.max(0, days)} 天`;
  const m = ageMonths(reg);
  if (m < 24) return `${m} 个月`;
  return `${(m / 12).toFixed(1)} 年`;
}

async function runDomains() {
  const my = ++D.run;
  const alive = () => my === D.run;
  await refreshContext();
  const tab = S.tab;
  if (!isSim(tab)) { Object.assign(D, { status: 'notsim' }); return render(); }
  // 这一轮自己的 key / host：后面每个 await 回来都先看还是不是这一轮，存快照只用这里的值
  const key = pageKey(tab.url);
  const host = hostOf(tab.url);
  Object.assign(D, {
    status: 'scanning', tabId: tab.id, url: tab.url, key, host,
    items: [], results: {}, done: 0, err: null, bases: [], baseId: null, baseSet: null, seen: {}, seenSince: 0, filter: 'all', goneOpen: false,
  });
  scrollTop('domains');
  render();
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectHosts });
    if (!alive()) return;
    const all = (await api('/normalize', { hosts: page.hosts, pageHost: page.pageHost })).items;
    if (!alive()) return;
    // 忽略本站：sim.3ue.co 自己的 3ue.co，以及它镜像的 similarweb.com（用户 10-12 定）
    const items = all.filter((x) => !x.self && !IGNORE_DOMAINS.has(x.domain));
    D.items = items;
    const [snaps, seen] = await Promise.all([
      loadSnapshots('domains', key, null),
      api('/snapshot/seen', { domains: items.map((x) => x.domain) }),
    ]);
    if (!alive()) return;
    D.bases = snaps.bases;
    D.seen = seen.seen || {};
    D.seenSince = seen.since || 0;  // 记录从哪天开始的；今天才开始记 = 头一回用，「从没见过」没有意义
    if (D.bases.length) await pickDomainBase(D.bases[0].id, my);
    if (!alive()) return;
    await api('/snapshot/save', { kind: 'domains', key, label: host, items: items.map((x) => ({ d: x.domain, hosted: x.hosted || null })) });
    if (!alive()) return;
    render();
    // 逐个域名查、6 路并发：个别 whois 慢不拖住别的；单个出错只记在那一行
    const look = items.filter((x) => !x.hosted).map((x) => x.domain);
    let next = 0;
    let down = null;
    const worker = async () => {
      while (next < look.length && alive() && !down) {
        const d = look[next++];
        try {
          const { results } = await api('/lookup', { domains: [d] });
          if (!alive()) return;
          Object.assign(D.results, results);
        } catch (e) {
          if (!alive()) return;
          if (e.down) down = e;
          D.results[d] = { reg: null, source: e.message, error: true };
        }
        D.done++;
        render();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (!alive()) return;
    if (down) throw down;
    D.status = 'done';
    render();
  } catch (e) {
    if (!alive()) return;
    D.status = 'error';
    D.err = e;
    render();
  }
}

async function pickDomainBase(id, my = D.run) {
  const { items } = await api('/snapshot/get', { id });
  if (my !== D.run) return;
  D.baseId = id;
  D.baseSet = new Set((items || []).map((x) => x.d));
}

// 上次扫这一页时没有的 = 首次出现；从没见过 = 在任何页面上都是今天第一次见到
function domainDiff() {
  const cur = new Set((D.items || []).map((x) => x.domain));
  const isNew = (d) => !!D.baseSet && !D.baseSet.has(d);
  const neverSeen = (d) => D.seenSince < startOfToday() && (D.seen[d] || 0) >= startOfToday();
  const gone = D.baseSet ? [...D.baseSet].filter((d) => !cur.has(d)) : [];
  const newCount = D.baseSet ? (D.items || []).filter((x) => isNew(x.domain)).length : 0;
  return { isNew, neverSeen, gone, newCount };
}

function sortedDomains() {
  const { results } = D;
  const look = D.items.filter((x) => !x.hosted);
  const found = look.filter((x) => results[x.domain]?.reg)
    .sort((a, b) => results[b.domain].reg.localeCompare(results[a.domain].reg));
  const pending = look.filter((x) => !(x.domain in results));
  const miss = look.filter((x) => x.domain in results && !results[x.domain].reg);
  const hosted = D.items.filter((x) => x.hosted).sort((a, b) => a.domain.localeCompare(b.domain));
  return { found, pending, miss, hosted };
}

function renderDomains() {
  if (D.status === 'notsim' || (D.status === 'idle' && !isSim(S.tab))) { view.innerHTML = NOT_SIM_CARD; return; }
  if (D.status === 'idle') {
    view.innerHTML = `<div class="list"><section class="card"><h2>本页的域名，新注册的在前</h2>
      <button class="btn primary big" type="button" data-act="scan">扫描本页域名</button></section></div>`;
    return;
  }
  if (D.status === 'error' && D.err?.down) { view.innerHTML = `<div class="list">${serviceDownCard('查注册日')}</div>`; return; }
  if (D.status === 'error' && !D.items?.length) {
    view.innerHTML = `<div class="list"><section class="card err"><h2>${ICON_ALERT}没扫成</h2><p>${esc(D.err?.message)}</p>
      <button class="btn primary self-start" type="button" data-act="scan">重新扫描</button></section></div>`;
    return;
  }
  const { found, pending, miss, hosted } = sortedDomains();
  const dd = domainDiff();
  const look = found.length + pending.length + miss.length;
  const fresh = found.filter((x) => ageMonths(D.results[x.domain].reg) < 12).length;
  const errors = miss.filter((x) => D.results[x.domain].error).length;
  const otherTab = S.tab && D.tabId !== S.tab.id;

  let html = '<div class="list">';
  if (otherTab) html += `<div class="ctxnote">下面是 ${esc(D.host)} 的结果${D.tabGone ? '（那个标签页已经关了）' : ''}。</div>`;
  html += `<section class="status"><div class="stat-row"><div class="stat"><span class="big">${D.items.length}</span><span class="unit">个域名</span></div>
    <span class="btns"><button class="btn" type="button" data-act="dom-copy">复制域名表</button><button class="btn" type="button" data-act="scan">${otherTab ? '扫描当前页' : '重新扫描'}</button></span></div>`;
  html += D.status === 'scanning'
    ? `<div class="meta">查询中 ${D.done} / ${look}…</div>`
    : `<div class="meta">查到 ${found.length} · 查不到 ${miss.length - errors}${errors ? ` · 出错 ${errors}（再扫一次重查）` : ''} · 1 年内注册 ${fresh} 个</div>`;
  if (D.bases.length) {
    html += `<div class="diff"><span>对比</span><select aria-label="对比的那次扫描" data-act="dom-base">${D.bases.map((b) =>
      `<option value="${esc(b.id)}"${b.id === D.baseId ? ' selected' : ''}>${esc(dayLabel(b))}</option>`).join('')}</select>
      <button class="fbtn" type="button" data-act="dom-filter" data-f="all" aria-pressed="${D.filter !== 'new'}">全部 ${D.items.length}</button>
      <button class="fbtn" type="button" data-act="dom-filter" data-f="new" aria-pressed="${D.filter === 'new'}"${dd.newCount ? '' : ' disabled'}>首次出现 ${dd.newCount}</button></div>`;
  } else if (D.items.length) {

  }
  html += '</section>';

  html += `<div class="sticky"><div class="colhead"><span class="c-kw">域名</span><span class="c-reg">注册日</span><span class="c-age">域龄</span></div></div>`;
  const onlyNew = D.filter === 'new';  // 「只看首次出现」
  const show = (x) => !onlyNew || dd.isNew(x.domain);
  // 一行一个标记，字和筛选按钮对得上：从没见过的一定也是这页首次出现，写成「首次出现 · 从没见过」
  const badges = (x) => (dd.isNew(x.domain) && dd.neverSeen(x.domain) ? '<span class="badge new" title="上次扫这一页时没有，而且以前在任何页面上都没见过（今天第一次见）">首次出现 · 从没见过</span>'
    : dd.neverSeen(x.domain) ? '<span class="badge seen" title="以前在任何页面上都没见过这个域名（今天第一次见）">从没见过</span>'
      : dd.isNew(x.domain) && !onlyNew ? '<span class="badge new" title="上次扫这一页时没有">首次出现</span>' : '');
  const tags = (x) => (x.via.length === 1 && x.via[0] === 'text' ? '<span class="tag" title="只在正文文字里出现，没有链接">文字</span>' : '');
  // 名字 → 打开网站 → 标记；放不下就折到下一行，不挤名字
  const name = (x) => `<div class="dname"><a class="ext" href="${esc(domainUrl(x.domain))}" title="${esc(x.hosts.join('\n'))}">${esc(x.domain)}</a>` +
    `<a class="ext site" href="https://${esc(x.domain)}/" title="打开 ${esc(x.domain)}" aria-label="打开 ${esc(x.domain)}">${ICON_OPEN}</a>${tags(x)}${badges(x)}</div>`;
  const rows = [...found, ...pending, ...miss].filter(show);
  for (const x of rows) {
    const r = D.results[x.domain];
    if (!r) html += `<div class="drow">${name(x)}<span class="c-miss">查询中…</span></div>`;
    else if (!r.reg) html += `<div class="drow">${name(x)}<span class="c-miss" title="${esc(r.source)}">${r.error ? '出错' : '查不到 · 注册局不公开'}</span></div>`;
    else html += `<div class="drow">${name(x)}<span class="c-reg" title="来源：${esc(r.source)}">${esc(r.reg)}</span><span class="c-age">${ageText(r.reg)}</span></div>`;
  }
  if (!rows.length) html += '<div class="empty">没有符合筛选的域名。</div>';
  const hostedShown = hosted.filter(show);
  if (hostedShown.length) {
    html += `<div class="group">托管子域 ${hostedShown.length} 个（不查注册日）</div>`;
    for (const x of hostedShown) html += `<div class="drow">${name(x)}<span class="c-miss">${esc(x.hosted)}</span></div>`;
  }
  if (dd.gone.length) {
    html += foldRow('dom-gone', D.goneOpen, `消失 ${dd.gone.length} 个：上次在这页，这次没有`);
    if (D.goneOpen) for (const d of dd.gone) html += `<div class="gone"><span>${esc(d)}</span></div>`;
  }
  html += '</div>';
  view.innerHTML = html;
}

async function copyDomains(btn) {
  const { found, pending, miss, hosted } = sortedDomains();
  const dd = domainDiff();
  const change = (x) => [dd.isNew(x.domain) ? '首次出现' : '', dd.neverSeen(x.domain) ? '从没见过' : ''].filter(Boolean).join('、');
  const lines = ['域名\t变化\t注册日\t域龄\t来源'];
  for (const x of [...found, ...pending, ...miss]) {
    const r = D.results[x.domain];
    lines.push([x.domain, change(x), r?.reg || '', r?.reg ? ageText(r.reg) : '', r ? r.source : '查询中'].join('\t'));
  }
  for (const x of hosted) lines.push([x.domain, change(x), '', '', `托管于 ${x.hosted}`].join('\t'));
  for (const d of dd.gone) lines.push([d, '消失', '', '', ''].join('\t'));
  await navigator.clipboard.writeText(lines.join('\n'));
  btn.textContent = '已复制';
}

// ================= 新进热词 =================

// H = 当前这一次收集的状态。新开一轮就换成新对象；旧的那一轮发现 H 不是自己了就悄悄退出，
// 不会再往新的一轮里写东西（Codex 10-12 #3）。status: probing | idle | notable | error | running | done
let H = { status: 'probing', loop: 0 };
let probeSeq = 0;

async function pageCall(tabId, name, ...args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (n, a) => (window.__pkHot ? window.__pkHot[n](...a) : { error: 'NOHOT' }),
    args: [name, args],
  });
  if (result && result.error === 'NOHOT') throw new Error('页面刷新或跳走了，已停止');
  return result;
}

// 注入页面脚本并标框（刷新过、清除过标注都要重新来）
async function ensurePage(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['hot.js'] });
  return pageCall(tabId, 'start');
}

// 读本页；表格还在加载就等一会儿再读
async function scanReady(tabId) {
  const until = Date.now() + PAGE_TIMEOUT;
  for (;;) {
    const s = await pageCall(tabId, 'scan');
    if (!s.loading) return s;
    if (Date.now() > until) throw new Error('表格 40 秒还没加载完');
    await sleep(400);
  }
}

// 看当前标签页能不能收集：注入、标框、读排序；再查这张表上次查的情况
async function probeHot() {
  const my = ++probeSeq;
  await refreshContext();
  const tab = S.tab;
  if (!isSim(tab)) { H = { status: 'notsim', loop: 0 }; return render(); }
  H = { status: 'probing', loop: 0, tabId: tab.id };
  render();
  try {
    const s = await ensurePage(tab.id);
    if (my !== probeSeq) return;
    if (s.error) { H = { status: 'notable', loop: 0, tabId: tab.id }; return render(); }
    H = { status: 'idle', loop: 0, tabId: tab.id, ctx: s.ctx, url: s.url, sort: s.sort, host: simKey(s.url) || hostOf(s.url) };
    render();
    if (s.loading) return;  // 表还在加载：先不查快照，开始收集时会再读
    const snaps = await loadSnapshots('hot', s.ctx, s.url);
    if (my !== probeSeq || H.tabId !== tab.id) return;
    H.prevInfo = snaps.bases[0] || null;
    render();
  } catch (e) {
    if (my !== probeSeq) return;
    H = { status: e.down ? 'error' : 'notable', loop: 0, tabId: tab.id, err: e };
    render();
  }
}

// resume=false：对当前标签页从第 1 页开始新的一轮；true：接着这一轮停下的地方再收
async function runCollect({ resume = false } = {}) {
  let job;
  if (resume) {
    job = H;
  } else {
    await refreshContext();
    if (!isSim(S.tab)) { H = { status: 'notsim', loop: 0 }; return render(); }
    job = { status: 'running', loop: 0, tabId: S.tab.id, items: [], kws: new Set(), passAll: new Map(), allRanks: new Map(),
      pageSize: 0, pagesDone: 0, lastPage: 0, bases: [], others: [], baseId: null, base: null, filter: 'all', goneOpen: false };
    H = job;
    scrollTop('hot');
  }
  const my = ++job.loop;  // 这一轮的令牌：清除标注、再开一轮、再点继续都会让它作废
  const alive = () => H === job && job.loop === my;
  const tabId = job.tabId;
  const call = (name, ...args) => pageCall(tabId, name, ...args);
  Object.assign(job, { status: 'running', stopReq: false, err: null, reason: null, returnFailed: false, resumed: resume });
  render();
  try {
    const st = await ensurePage(tabId);
    if (!alive()) return;
    if (st.error) throw new Error(st.error);
    let s = await scanReady(tabId);
    if (!alive()) return;
    if (s.error) throw new Error(s.error);
    if (!resume) {
      Object.assign(job, { ctx: s.ctx, url: s.url, sort: s.sort, host: simKey(s.url) || hostOf(s.url) });
    } else if (s.ctx !== job.ctx) {
      throw new Error('表格换了排序或筛选，请点「重新收集」');
    }
    job.startPage = s.cur;
    job.runPages = 0;
    job.total = s.total;
    const first = resume ? job.lastPage + 1 : 1;
    if (s.cur !== first) {
      const ok = await withTimeout(call('goto', first), PAGE_TIMEOUT);
      if (!alive()) return;
      if (!ok) throw new Error(`翻不到第 ${first} 页`);
    }
    for (;;) {
      s = await scanReady(tabId);
      if (!alive()) return;
      if (s.error) throw new Error(s.error);
      if (s.ctx !== job.ctx) throw new Error('表格换了排序或筛选，已停止');
      if (!job.pageSize) job.pageSize = s.pageSize;
      else if (s.pageSize !== job.pageSize && s.hasNext) throw new Error('每页条数变了，名次会对不上，请点「重新收集」');
      const rankOf = (i) => (s.cur - 1) * job.pageSize + i + 1;
      s.all.forEach((kw, i) => { if (!job.allRanks.has(kw)) job.allRanks.set(kw, rankOf(i)); });
      for (const x of s.items) {
        if (!job.passAll.has(x.kw)) job.passAll.set(x.kw, x);
        if (job.items.length >= TARGET || job.kws.has(x.kw)) continue;
        job.kws.add(x.kw);
        job.items.push({ ...x, page: s.cur, rank: rankOf(x.i) });
      }
      // 实际扫到的最后一个名次（最后一页可能不满一页）
      Object.assign(job, { pagesDone: job.pagesDone + 1, runPages: job.runPages + 1, lastPage: s.cur, total: s.total,
        coverage: rankOf(s.all.length - 1) });
      render();
      if (job.items.length >= TARGET) { job.reason = 'full'; break; }
      if (!s.hasNext) { job.reason = 'end'; break; }
      if (job.stopReq) { job.reason = 'stopped'; break; }
      if (job.runPages >= PAGE_CAP) { job.reason = 'cap'; break; }
      await sleep(PAGE_GAP);
      if (!alive()) return;
      if (job.stopReq) { job.reason = 'stopped'; break; }
      const ok = await withTimeout(call('next'), PAGE_TIMEOUT);
      if (!alive()) return;
      if (!ok) throw new Error(`第 ${s.cur + 1} 页 40 秒没加载出来`);
    }
  } catch (e) {
    if (!alive()) return;
    job.reason = 'error';
    job.err = /No tab with id/i.test(e.message) ? new Error('收集用的标签页被关了') : e;
  }
  if (job.stopReq && job.reason !== 'error') job.reason = 'stopped';
  if (job.startPage) {  // 回到用户原来那一页
    const back = await withTimeout(call('goto', job.startPage).catch(() => false), PAGE_TIMEOUT);
    if (!alive()) return;
    job.returnFailed = !back;
  }
  if (['full', 'end', 'cap'].includes(job.reason)) {
    try { await saveAndCompare(job, alive); } catch (e) { if (alive()) job.err = e; }
    if (!alive()) return;
  }
  job.status = 'done';
  render();
}

// 存快照（这张表今天的那份会被替换）并和上次比
async function saveAndCompare(job, alive) {
  const snaps = await loadSnapshots('hot', job.ctx, job.url);
  if (!alive()) return;
  job.bases = snaps.bases;
  job.others = snaps.others;
  const keep = job.bases.find((b) => b.id === job.baseId);
  if (job.bases.length) await pickHotBase(job, keep ? keep.id : job.bases[0].id);
  else { job.base = null; job.baseId = null; }
  if (!alive()) return;
  const items = [...job.allRanks].map(([kw, rank]) => {
    const h = job.passAll.get(kw);
    return h ? { kw, rank, pass: 1, red: h.red ? 1 : 0, t: h.t, v: h.v } : { kw, rank };
  });
  await api('/snapshot/save', { kind: 'hot', key: job.ctx, family: job.url, label: job.sort || '默认排序', coverage: job.coverage, items });
  job.filter = 'all';
}

async function pickHotBase(job, id) {
  const { items } = await api('/snapshot/get', { id });
  job.baseId = id;
  job.base = new Map((items || []).map((x) => [x.kw, x]));
  // 上次那次查询收到的名单：达标行按表里顺序取前 TARGET 条；值 = 上次的收集名次
  const listed = (items || []).filter((x) => x.pass).sort((a, b) => a.rank - b.rank).slice(0, TARGET);
  job.baseOrder = new Map(listed.map((x, i) => [x.kw, i + 1]));
}

// 这一轮收完整了（取满 / 翻完 / 到上限）才和上次比；停止、出错的不比
const compared = (job) => job.status === 'done' && ['full', 'end', 'cap'].includes(job.reason) && !!job.base;

// 和上次比（用户 10-12 定）：每次查询独立，只要符合规则就是热词；
// 上次查询的热词名单里没有的，标「首次出现」。消失 = 上次名单里有、这次扫过的范围里没达标或不在表里
function hotDiff(job) {
  const counts = { first: 0 };
  const chg = new Map();
  if (!compared(job)) return { counts, chg, gone: [] };
  for (const x of job.items) {
    if (!job.baseOrder.has(x.kw)) { chg.set(x.kw, 'first'); counts.first++; }
  }
  const gone = [...job.baseOrder].map(([kw, order]) => ({ kw, order, rank: job.base.get(kw).rank }))
    .filter((g) => g.rank <= job.coverage && !job.passAll.has(g.kw));
  return { counts, chg, gone };
}

const fmtRatio = (x) => `${x.ge ? '≥' : ''}${x.ratio >= 100 ? Math.round(x.ratio) : x.ratio.toFixed(1)}×`;  // ≥100 显示整数，倍数列才放得下

// 热门网址只显示站名（去掉 www.）：这个词的流量是大站在吃还是新站在吃，一眼看得出（用户 10-12 同意资深用户的建议）
function topHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
// 太长就省中间、留后缀：「my-very-long….vercel.app」——靠 .vercel.app 这种后缀一眼认出托管小站（资深用户 10-12）
function shortHost(host) {
  if (host.length <= 22) return host;
  const parts = host.split('.');
  const tail = '.' + parts.slice(-2).join('.');
  return parts.length > 2 ? host.slice(0, Math.max(4, 21 - tail.length)) + '…' + tail : host;
}

// 一行一个词：关键词、Trends、首次出现排在一起（放不下才折行），数字列对齐第一行；
// 热门网址的站放在数字列下面（关键词本来就两行时不加高，跟在 Trends 后面会多出一行）
function hotRow(x, order, chg, filter) {
  const badge = chg.get(x.kw) && filter !== 'first' ? '<span class="badge new" title="上次查询的名单里没有">首次出现</span>' : '';
  const host = topHost(x.url);
  // Trends 后面：直接打开这个词的热门网址，看那一页具体是什么内容（用户 10-12 要的）
  const page = /^https?:\/\//i.test(x.url || '') ? `<a class="ext site" href="${esc(x.url)}" title="打开热门网址：${esc(x.url)}" aria-label="打开热门网址">${ICON_OPEN}</a>` : '';
  const top = host ? `<a class="ext topurl" href="${esc(domainUrl(host))}" title="热门网址：${esc(x.url)}\n点开看 ${esc(host)} 的新进关键词">${esc(shortHost(host))}</a>` : '';
  return `<div class="hrow"><span class="c-rank">${order}</span>
    <div class="kwcell"><a class="ext kw" href="${esc(kwUrl(x.kw))}" title="${esc(x.kw)}（表里第 ${x.rank} 名）">${esc(x.kw)}</a>
      <a class="ext trends" href="${esc(trendsUrl(x.kw))}" title="Google Trends 近 1 个月，和 ${TRENDS_BASE} 对比">Trends</a>${page ? ' ' + page : ''} ${badge}</div>
    <div class="nums"><div class="numrow"><span class="c-num">${esc(x.t)}</span><span class="c-num dim">${esc(x.v)}</span>
      <span class="c-ratio"><span class="ratio ${x.red ? 'red' : 'orange'}">${fmtRatio(x)}</span></span></div>${top}</div></div>`;
}

const COLHEAD = (label) => `<div class="sticky"><div class="colhead"><span class="c-rank">#</span><span class="c-kw">${label}</span><span class="c-num">28 天</span><span class="c-num">平均</span><span class="c-ratio" title="${RULE}">倍数</span></div></div>`;
// 规则 + 红橙各几条，收集前后都是这一行
const RULE = 'KD=0 · 倍数 = 28 天流量 ÷ 平均体量';
const tierText = (reds, oranges) => `红 ${reds} · 橙 ${oranges}`;
const pagesText = (done, total) => (total && total <= PAGE_CAP ? `第 ${done} / ${total} 页` : `第 ${done} / ${PAGE_CAP} 页（共 ${total ?? '…'}）`);

function renderHot() {
  if (H.status === 'probing') { view.innerHTML = '<div class="list"><div class="empty">正在看这个页面…</div></div>'; return; }
  if (H.status === 'notsim') { view.innerHTML = NOT_SIM_CARD; return; }
  if (H.status === 'error' && H.err?.down) { view.innerHTML = `<div class="list">${serviceDownCard('和上次比')}</div>`; return; }
  if (H.status === 'notable' || H.status === 'error') {
    view.innerHTML = `<div class="list"><section class="card"><h2>${ICON_TABLE}这个页面没有关键词表</h2>
      <p>新进热词要在 sim 的「关键词」表格页上用：表头里得有关键词、KD、28 天流量、平均体量四列。</p>
      <p>最快的办法：在「域名注册时间」里点某个域名，会打开它的新进关键词页。</p>
      <button class="btn self-start" type="button" data-act="go-domains">去「域名注册时间」</button></section></div>`;
    return;
  }
  if (H.status === 'idle') {
    const p = H.prevInfo;
    const prev = p ? `${esc(p.day.slice(5))}（${esc(dayLabel(p).split(' · ')[1])}），收完自动对比` : '没有，这次收完存下来，下次就能比';
    view.innerHTML = `<div class="list"><section class="card"><h2>按当前排序取前 ${TARGET} 条热词</h2>
      <dl><dt>当前排序</dt><dd>${esc(H.sort || '页面默认')}</dd><dt>上次查</dt><dd>${prev}</dd></dl>
      <button class="btn primary big" type="button" data-act="collect">收集前 ${TARGET} 条热词</button></section></div>`;
    return;
  }

  const items = H.items || [];
  const d = hotDiff(H);
  const otherTab = H.tabGone || (S.tab && H.tabId !== S.tab.id);
  const reds = items.filter((x) => x.red).length;
  let html = '<div class="list">';
  if (H.tabGone) html += '<div class="ctxnote">收集用的那个 sim 标签页已经关了，下面的结果还能看、能导出；要接着收，打开关键词表后点「收集当前表」。</div>';
  else if (otherTab) html += `<div class="ctxnote">下面是 ${esc(H.host)} 关键词表的结果${H.status === 'running' ? '（还在收集）' : ''}。</div>`;
  if (H.status === 'running') {
    const pageText = H.resumed ? `第 ${H.lastPage || '…'} 页 · 本轮 ${H.runPages || 0} / ${PAGE_CAP}` : pagesText(H.runPages || 0, H.total);
    html += `<section class="status"><div class="stat-row"><div class="stat"><span class="big">${items.length}</span><span class="unit">/ ${TARGET} 条热词</span></div>
      <button class="btn" type="button" data-act="stop"${H.stopReq ? ' disabled' : ''}>${H.stopReq ? '正在停止' : '停止'}</button></div>
      <div class="bar"><i style="width:${Math.min(100, items.length / TARGET * 100).toFixed(1)}%"></i></div>
      <div class="meta">${pageText} · 按「${esc(H.sort || '页面默认排序')}」 · ${tierText(reds, items.length - reds)}</div></section>`;
  } else {
    // 只有不正常的结束才挂标签；取满是常态，不说
    const head = { end: '整张表翻完了', cap: `不足 ${TARGET}`, stopped: '已停止', error: '中途出错' }[H.reason] || '';
    const restart = `<button class="btn" type="button" data-act="collect">${otherTab ? '收集当前表' : '重新收集'}</button>`;
    const more = otherTab ? '' : H.reason === 'stopped' || H.reason === 'error'
      ? '<button class="btn outline" type="button" data-act="resume">继续收集</button>'
      : H.reason === 'cap' ? `<button class="btn outline" type="button" data-act="resume">再翻 ${PAGE_CAP} 页</button>` : '';
    const exp = items.length ? '<button class="btn" type="button" data-act="export" title="按收集顺序，含热门网址；有对比时带变化列">导出 CSV</button>' : '';
    html += `<section class="status"><div class="stat-row"><div class="stat"><span class="big">${items.length}</span><span class="unit">条热词${head ? ` · ${head}` : ''}</span></div>
      <span class="btns">${more}${exp}${restart}</span></div>
      <div class="meta">按「${esc(H.sort || '页面默认排序')}」${H.reason === 'end' ? ` · 共 ${H.lastPage} 页` : ''} · ${tierText(reds, items.length - reds)}</div>
      ${!H.tabGone && H.returnFailed ? `<div class="meta"><b>没能自动回到第 ${H.startPage} 页</b></div>` : ''}`;
    if (H.reason === 'cap') html += `<div class="meta">已翻 ${H.runPages} 页仍不足 ${TARGET} 条，先停在这里。</div>`;
    if (H.reason === 'stopped') html += '<div class="meta">没收完，不和上次比，也不存。</div>';
    if (H.reason === 'error') html += `<div class="meta">出错：${esc(H.err?.message)}。已收的保留，可以接着收。</div>`;
    if (H.err && H.reason !== 'error') html += `<div class="meta">${esc(H.err.message)}</div>`;
    if (compared(H)) {
      const f = (k, label, n) => `<button class="fbtn" type="button" data-act="hot-filter" data-f="${k}" aria-pressed="${H.filter === k}"${n || k === 'all' ? '' : ' disabled'}>${label} ${n}</button>`;
      html += `<div class="diff"><span>对比</span><select aria-label="对比的那次查询" data-act="hot-base">${H.bases.map((b) =>
        `<option value="${esc(b.id)}"${b.id === H.baseId ? ' selected' : ''}>${esc(dayLabel(b))}</option>`).join('')}</select>
        ${f('all', '全部', items.length)}${f('first', '首次出现', d.counts.first)}</div>`;
    } else if (['full', 'end', 'cap'].includes(H.reason)) {
      const other = H.others?.[0];
      if (other) html += `<div class="meta">${other
        ? `另有 ${esc(dayLabel(other))} 的快照，但那次按「${esc(other.label)}」排序，不能比。` : ''}</div>`;
    }
    html += '</section>';
  }

  const filter = compared(H) ? H.filter : 'all';
  const orderOf = new Map(items.map((x, i) => [x.kw, i + 1]));  // 名次 = 收集后的顺序
  const shown = filter === 'first' ? items.filter((x) => d.chg.has(x.kw)) : items;
  html += COLHEAD(filter === 'first' ? '关键词 · 只看首次出现' : '关键词');
  html += shown.map((x) => hotRow(x, orderOf.get(x.kw), d.chg, filter)).join('') || `<div class="empty">${H.status === 'running' ? '还没收到符合规则的词…' : '没有符合筛选的词。'}</div>`;
  if (d.gone.length) {
    html += foldRow('hot-gone', H.goneOpen, `消失 ${d.gone.length} 个：上次在名单里，这次不在或没过线`);
    if (H.goneOpen) for (const g of d.gone) html += `<div class="gone"><span>${esc(g.kw)}</span><span class="num">上次第 ${g.order} 名</span></div>`;
  }
  html += '</div>';
  view.innerHTML = html;
}

function exportHot() {
  const job = H;
  const d = hotDiff(job);
  const cmp = compared(job);
  const head = ['框色', ...(cmp ? ['变化'] : []), '名次', ...(cmp ? ['上次名次'] : []), '表内名次', '关键词', 'KD', '28 天流量', '平均体量', '倍数', '倍数是下限', '热门网址'];
  const lines = [head.map((h) => csvCell(h)).join(',')];
  job.items.forEach((x, i) => {  // 按收集顺序（= 当前排序下的先后）
    lines.push([
      csvCell(x.red ? '红' : '橙'), ...(cmp ? [csvCell(d.chg.has(x.kw) ? '首次出现' : '')] : []), csvCell(i + 1),
      ...(cmp ? [csvCell(job.baseOrder.get(x.kw) ?? '')] : []), csvCell(x.rank),
      csvCell(x.kw, true), csvCell(x.kd), csvCell(x.t), csvCell(x.v), csvCell(x.ratio.toFixed(1)),
      csvCell(x.ge ? '是（平均体量 < 50）' : ''), csvCell(x.url, true),
    ].join(','));
  });
  const blank = head.length - 6;  // 消失的词：补齐列数
  for (const g of d.gone) lines.push([csvCell(''), csvCell('消失'), csvCell(''), csvCell(g.order), csvCell(''), csvCell(g.kw, true), ...Array(blank).fill(csvCell(''))].join(','));
  download(`新进热词_${(job.host || 'sim').replace(/[^\w.-]/g, '_')}_${today()}.csv`, lines);
}

// ================= 找词：web.cafe 新词发现服务的基础词 =================
// 取「长期大词」整页（602 个，含老词 / 无标签 / 二次爆火 / 新词标签）和「二次爆火」两组（用户 10-12 定），
// 按方向分；每个词照样显示它自己在 web.cafe 的标签。点词跳 sim 的 SERP 市场参与者页。

const WEBCAFE = 'https://new.web.cafe';
const WC_TABS = { evergreen: '长期大词', resurgence: '二次爆火' };
const WC_CACHE = 'webcafe-v2';
const WC_DIRS = ['AI', '工具', '游戏', '其它'];
const WC_TTL = 12 * 3600 * 1000;  // 缓存 12 小时；web.cafe 每天扫几批
const W = { status: 'idle', items: [], q: '', dir: 'all', group: 'all' };

// 拉 web.cafe 列表页（服务端渲染的 HTML）并解析卡片。要能整段塞进 executeScript，所以不引用外面任何东西
async function webcafeFetchAll(tabs, maxPages = 60) {
  const DIRS = ['AI', '工具', '游戏', '其它'];
  const TAGS = ['老词', '二次爆火', '新词', '推荐过', '上升中', '回落中', '高位', '小游戏'];
  const VERD = ['值得做', '可以试试', '还没判断', '不值得做'];
  const items = []; const meta = {};
  for (const tab of tabs) {
    let page = 1, pages = 1;
    do {
      const r = await fetch(`https://new.web.cafe/keywords?tab=${tab}&page=${page}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`web.cafe HTTP ${r.status}`);
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const main = doc.querySelector('main');
      if (!main) break;
      const pm = main.textContent.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
      pages = pm ? +pm[2] : page;
      if (page === 1) { const f = main.textContent.match(/找到\s*([\d,]+)\s*个/); meta[tab] = { found: f ? +f[1].replace(/,/g, '') : null, pages }; }
      for (const a of main.querySelectorAll('a[href^="/keywords/"]')) {
        const leaves = [...a.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim()).filter(Boolean);
        if (!leaves.length) continue;
        const gi = leaves.indexOf('GPTs');
        const g = (gi >= 0 && (leaves[gi + 1] || '').match(/^×\s*([\d.]+)$/)) || leaves.map((l) => l.match(/^GPTs\s*×\s*([\d.]+)$/)).find(Boolean);
        items.push({ kw: leaves[0], tab, dir: DIRS.find((d) => leaves.slice(1, 3).includes(d)) || '其它',
          tags: TAGS.filter((t) => leaves.includes(t)), verdict: VERD.find((v) => leaves.includes(v)) || '',
          gpts: g ? +g[1] : null, desc: leaves.find((l, i) => i > 0 && l.length >= 12 && !/爆发|出现|自身近/.test(l)) || '',
          slug: a.getAttribute('href').split('?')[0] });
      }
      page++;
      await new Promise((res) => setTimeout(res, 250));
    } while (page <= pages && page <= maxPages);
  }
  return { items, meta };
}

// 侧边栏直接请求（带你在 Chrome 里的 web.cafe 登录）；拿不到就借一个 web.cafe 标签页在页面里请求
async function fetchWebcafe() {
  const tabs = Object.keys(WC_TABS);
  try {
    const r = await webcafeFetchAll(tabs);
    if (r.items.length) return r;
  } catch (e) { console.warn('web.cafe 直接请求失败', e); }
  let [tab] = await chrome.tabs.query({ url: `${WEBCAFE}/*` });
  let made = null;
  if (!tab) {
    made = await chrome.tabs.create({ url: `${WEBCAFE}/keywords?tab=evergreen`, active: false });
    await new Promise((res) => {
      const done = (id, info) => { if (id === made.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); res(); } };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(res, 20000);
    });
    tab = made;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: webcafeFetchAll, args: [tabs] });
    return result;
  } finally {
    if (made) chrome.tabs.remove(made.id).catch(() => {});
  }
}

// 同一个词可能两组都有：合成一条，记下属于哪些组
function mergeWords(raw) {
  const by = new Map();
  for (const x of raw) {
    const w = by.get(x.kw) || { kw: x.kw, dir: x.dir, groups: [], tags: [], verdict: x.verdict, gpts: x.gpts, desc: x.desc, slug: x.slug };
    if (!w.groups.includes(WC_TABS[x.tab])) w.groups.push(WC_TABS[x.tab]);
    for (const t of x.tags) if (!w.tags.includes(t)) w.tags.push(t);
    if (x.gpts != null && (w.gpts == null || x.gpts > w.gpts)) w.gpts = x.gpts;
    w.desc ||= x.desc; w.verdict ||= x.verdict;
    by.set(x.kw, w);
  }
  return [...by.values()].sort((a, b) => (b.gpts ?? -1) - (a.gpts ?? -1));
}

// 项目里带的一份数据（extension/seed/，用 tools/export-seed.py 从插件存储导出）：本地还没有时先用它，第一次打开也有数据（用户 10-12 要的）
async function seedData(name) {
  try { return await (await fetch(chrome.runtime.getURL(`seed/${name}`))).json(); } catch { return null; }
}

async function loadWords({ force = false } = {}) {
  if (W.status === 'loading' || W.refreshing) return;
  // 先拿手上有的：存着的那份，没有就用项目里带的那份
  if (!W.items.length) {
    let c = (await chrome.storage.local.get(WC_CACHE).catch(() => ({})))[WC_CACHE];
    if (!c?.items?.length) {
      c = await seedData('webcafe.json');
      if (c?.items?.length) chrome.storage.local.set({ [WC_CACHE]: c }).catch(() => {});
    }
    if (c?.items?.length) Object.assign(W, { status: 'done', items: c.items, meta: c.meta, at: c.at });
  }
  if (!force && W.items.length && Date.now() - W.at < WC_TTL) return render();
  // 手上有词就边看边在后台更新，更新失败也照样用这份；一个词都没有才显示「正在拉取」
  if (W.items.length) Object.assign(W, { refreshing: true, err: null });
  else Object.assign(W, { status: 'loading', err: null });
  render();
  try {
    const r = await fetchWebcafe();
    if (r?.items?.length) {
      const items = mergeWords(r.items);
      Object.assign(W, { status: 'done', items, meta: r.meta, at: Date.now() });
      chrome.storage.local.set({ [WC_CACHE]: { items, meta: r.meta, at: W.at } }).catch(() => {});
    } else if (W.items.length) W.err = new Error('没登录 web.cafe');
    else W.status = 'login';
  } catch (e) {
    if (W.items.length) W.err = e;
    else Object.assign(W, { status: 'error', err: e });
  }
  W.refreshing = false;
  render();
}

const fmtTime = (ms) => { const d = new Date(ms); return `${d.toLocaleDateString('sv').slice(5)} ${d.toTimeString().slice(0, 5)}`; };
const fmtGpts = (v) => (v == null ? '' : v >= 100 ? `${Math.round(v)}×` : `${v >= 1 ? v.toFixed(1) : v.toFixed(3)}×`);

function wordsShown() {
  const q = W.q.trim().toLowerCase();
  return W.items.filter((w) => (W.dir === 'all' || w.dir === W.dir) && (W.group === 'all' || w.groups.includes(W.group)) &&
    (!q || w.kw.toLowerCase().includes(q) || w.tags.some((t) => t.includes(q)) || (w.verdict || '').includes(q)));
}

// 灰字只放标签和判断（方向、分组上面有筛选）；每段不在中间断行
const metaLine = (parts) => parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('');

function wordRow(w, i) {
  return `<div class="hrow tall"><span class="c-rank">${i + 1}</span>
    <div class="kwcell"><a class="ext kw" href="${esc(kwUrl(w.kw))}" title="${esc(w.desc)}">${esc(w.kw)}</a>
      <a class="ext trends" href="${esc(trendsUrl(w.kw))}" title="Google Trends 近 1 个月，和 ${TRENDS_BASE} 对比">Trends</a></div>
    <span class="c-gpts" title="近 7 天热度是 gpts 的多少倍（web.cafe 口径）">${fmtGpts(w.gpts)}</span>
    <div class="kwmeta">${metaLine([...w.tags.filter((t) => !w.groups.includes(t)).map(esc), esc(w.verdict),
      `<a class="ext" href="${esc(WEBCAFE + w.slug)}" title="在 web.cafe 看这个词的判断和 SERP">web.cafe ›</a>`])}</div></div>`;
}

// 只重画列表（打字时用，搜索框不丢焦点）
function renderWordList() {
  const shown = wordsShown();
  const list = view.querySelector('#wlist');
  const count = view.querySelector('#wcount');
  if (count) count.textContent = `${shown.length} 个`;
  if (list) list.innerHTML = shown.slice(0, 1000).map(wordRow).join('') || '<div class="empty">没有符合条件的词。</div>';
}

function renderWords() {
  if (W.status === 'idle') { view.innerHTML = ''; loadWords(); return; }
  if (W.status === 'loading') {
    view.innerHTML = `<div class="list"><section class="status"><div class="stat-row"><div class="stat"><span class="unit">正在从 web.cafe 拉取长期大词和二次爆火…</span></div></div>
</section></div>`;
    return;
  }
  if (W.status === 'login' || (W.status === 'error' && !W.items.length)) {
    view.innerHTML = `<div class="list"><section class="card err"><h2>${ICON_ALERT}没从 web.cafe 拿到数据</h2>
      <p>${W.status === 'login' ? '多半是没登录，或账号没有「数据服务」权限。' : esc(W.err?.message)}先在 Chrome 里打开 web.cafe 登录，回到这里会自动再试。</p>
      <div class="btns start"><a class="btn primary ext" href="${WEBCAFE}/keywords?tab=evergreen">打开 web.cafe 登录</a>
      <button class="btn" type="button" data-act="w-refresh">重新读取</button></div></section></div>`;
    return;
  }
  const cnt = (f) => W.items.filter(f).length;
  const chip = (act, k, label, n, cur) => `<button class="fbtn" type="button" data-act="${act}" data-f="${esc(k)}" aria-pressed="${cur === k}">${esc(label)} ${n}</button>`;
  view.innerHTML = `<div class="list"><section class="status"><div class="stat-row"><div class="stat"><span class="big">${W.items.length}</span><span class="unit">个基础词</span>
</div>
      <button class="btn" type="button" data-act="w-refresh"${W.refreshing ? ' disabled' : ''}>${W.refreshing ? '正在更新' : '重新拉取'}</button></div>
    <div class="meta">web.cafe · ${fmtTime(W.at)} 拉取${W.refreshing ? ' · 正在更新…' : ''}${W.err ? ` · 更新失败：${esc(W.err.message)}` : ''}</div>
    <div class="frow"><span class="lbl">方向</span><div class="chips">${chip('w-dir', 'all', '全部', W.items.length, W.dir)}${WC_DIRS.map((d) => chip('w-dir', d, d, cnt((w) => w.dir === d), W.dir)).join('')}</div></div>
    <div class="frow"><span class="lbl">分组</span><div class="chips">${chip('w-group', 'all', '全部', W.items.length, W.group)}${Object.values(WC_TABS).map((g) => chip('w-group', g, g, cnt((w) => w.groups.includes(g)), W.group)).join('')}</div></div>
    </section>
    <div class="sticky"><div class="toolbar"><input class="search" type="search" placeholder="搜词或标签，比如 pdf、上升中" value="${esc(W.q)}" aria-label="搜词或标签" data-act="w-search"></div>
    <div class="colhead"><span class="c-rank">#</span><span class="c-kw">关键词 · <span id="wcount"></span></span><span class="c-gpts">热度÷gpts</span></div></div>
    <div id="wlist"></div></div>`;
  renderWordList();
}

// ================= 找站：Stripe 结账页的引荐网站 =================
// sim 上 checkout.stripe.com 的「外链 → 引荐网站」表（近 28 天、全球），约 970 个站、每页 100 个。
// 能把访客送进 Stripe 结账页的站，就是在收钱的站。存下来以后满 30 天才自动重拉，其余时间不动它，
// 除非用户点「重新拉取」（用户 10-12 定）。和上一份比：上一份没有的标「首次出现」。

const REF_URL = `${SIM}/digitalsuite/websiteanalysis/referrals/*/999/28d?webSource=Total&selectedTab=incomingTraffic&key=checkout.stripe.com`;
const REF_CACHE = 'stripe-ref-v1';
const REF_WAIT = 60000;   // 新开的 sim 页面要等登录态和数据，表格出来可能要十几秒
const REF_PAGE_CAP = 30;  // 正常 10 页；防页数读错一直翻
const REF_TTL = 30 * 86400000;  // 存满 30 天才自动重拉
const refDue = (at) => Date.now() - at >= REF_TTL;
const ignoredDomain = (d) => [...IGNORE_DOMAINS].some((x) => d === x || d.endsWith('.' + x));
const R = { status: 'idle', items: [], q: '', ind: 'all', filter: 'all', young: false, run: 0, dom: {}, reg: {} };

// 是不是就是我们要的那张表（全球、28 天、全部流量、引荐网站页签、checkout.stripe.com）
function isRefPage(url) {
  try {
    const h = new URL(url).hash;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    return isSim({ url }) && h.startsWith('#/digitalsuite/websiteanalysis/referrals/*/999/28d?') &&
      q.get('key') === 'checkout.stripe.com' && q.get('webSource') === 'Total' && q.get('selectedTab') === 'incomingTraffic';
  } catch { return false; }
}

async function refCall(tabId, name, ...args) {
  // injectImmediately：页面还在加载也马上进去（默认要等 document_idle，停止打断不了，Codex 10-12 第三轮 #3）
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, injectImmediately: true,
    func: (n, a) => (window.__pkRef ? window.__pkRef[n](...a) : { error: 'NOREF' }),
    args: [name, args],
  });
  if (result && result.error === 'NOREF') throw new Error('引荐页刷新或跳走了，已停止');
  return result;
}

// 翻页 / 回第 1 页：页面脚本点之前先核对地址还是这张表（用户可能刚跳走）；超时就让页面断开还在等的观察器
async function refStep(tabId, name, href) {
  const ok = await withTimeout(refCall(tabId, name, href), PAGE_TIMEOUT);
  if (ok === 'moved') throw new Error('引荐页跳到别的页面了，已停止');
  if (!ok) await refCall(tabId, 'cancel').catch(() => {});
  return ok === true;
}

// 等表格出来再读：页面还在打开时注入会失败，表格在加载时读到 loading，都隔一秒再试；这一轮被停掉就不等了
// 等一个 Promise，但这一轮被停掉或超过期限就不等了（返回 null）
async function untilDone(p, alive, ms) {
  const end = Date.now() + ms;
  let done = false;
  p.finally(() => { done = true; }).catch(() => {});
  while (!done) {
    if (!alive() || Date.now() > end) return null;
    await sleep(200);
  }
  return p;
}

async function refReady(tabId, timeout, alive = () => true) {
  const until = Date.now() + timeout;
  for (;;) {
    if (!alive()) return null;
    try {
      const s = await untilDone((async () => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['ref.js'], injectImmediately: true });
        return refCall(tabId, 'scan');
      })(), alive, Math.max(1000, until - Date.now()));
      if (s && !s.loading) return s;
    } catch (e) {
      if (/No tab with id/.test(e.message)) throw new Error('引荐页被关掉了');
    }
    if (Date.now() > until || !alive()) return null;
    await sleep(1000);
  }
}

// 已经开着这张表就直接用（不用再等登录和加载），没有就在后台开一个
async function refTab() {
  const open = (await chrome.tabs.query({ url: 'https://sim.3ue.co/*' })).find((t) => isRefPage(t.url));
  if (open) return { tabId: open.id, made: false };
  const t = await chrome.tabs.create({ url: REF_URL, active: false });
  return { tabId: t.id, made: true };
}

const refFrom = (c) => ({ items: c.items, at: c.at, total: c.total, short: c.short || '', prev: c.prev || null });
const refCache = async () => (await chrome.storage.local.get(REF_CACHE).catch(() => ({})))[REF_CACHE] || null;

// 正在跑的那一轮：{ cancelled, committing, tabId, made, touched, finished }。停止 / 新的一轮都要等旧的一轮收拾完
let refJob = null;
// 我们后台开的那页，用户切过去看过、或者在里面跳到别的页面了，就归用户了：读完不关（Codex 10-12 第二轮 #1）。
// 按标签页记，一直记到那一轮收拾完——停止后马上重拉时，旧一轮还在收拾，用户碰它也要算在旧一轮身上（第三轮 #1）
const refTabJobs = new Map();
chrome.tabs.onActivated.addListener(({ tabId }) => { const j = refTabJobs.get(tabId); if (j) j.touched = true; });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const j = refTabJobs.get(tabId);
  if (j && info.url && !isRefPage(info.url)) j.touched = true;
});

// 收拾这一轮用过的标签页：断开页面里的等待；自己开的、用户没碰过、还停在引荐页、又不在前台的才关，
// 用户开着的那页（还是这张表才）回第 1 页。侧边栏中途被关掉时这里跑不到：后台那页留着，下次拉取直接复用它。
// 停止时和这一轮自己结束时都会调，同一个标签页只收拾一次
function cleanupRefJob(job) {
  if (job.tabId == null) return Promise.resolve();
  if (job.cleanedTab !== job.tabId) {
    job.cleanedTab = job.tabId;
    const { tabId, made } = job;
    job.cleaning = (async () => {
      await withTimeout(refCall(tabId, 'cancel'), 3000).catch(() => {});
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t || !isRefPage(t.url)) return;
      if (made && !job.touched && !t.active) await chrome.tabs.remove(tabId).catch(() => {});
      else if (!made) await refStep(tabId, 'first', t.url).catch(() => {});
    })().catch(() => {}).finally(() => { if (refTabJobs.get(tabId) === job) refTabJobs.delete(tabId); });
  }
  return job.cleaning;
}

async function loadRefs({ force = false } = {}) {
  if (refJob && !refJob.cancelled) return;  // 已经有一轮在跑：不开第二轮（双击、反复点页签）
  const prevJob = refJob;
  let finish;
  const job = { cancelled: false, tabId: null, made: false, touched: false, finished: new Promise((r) => { finish = r; }) };
  refJob = job;
  const alive = () => refJob === job && !job.cancelled;
  try {
    if (prevJob) await prevJob.finished;  // 被停掉的上一轮先收拾完
    if (!alive()) return;
    let cache = await refCache();
    if (!cache?.items?.length) {  // 本地还没有：用项目里带的那份，当成存着的那份（30 天从它的拉取时间算）
      const seed = await seedData('stripe-ref.json');
      if (seed?.items?.length) { cache = seed; await chrome.storage.local.set({ [REF_CACHE]: seed }).catch(() => {}); }
    }
    if (!alive()) return;
    const has = !!cache?.items?.length;
    if (has) Object.assign(R, refFrom(cache));
    // 没满 30 天就用存着的那份，不去动它；满了自动重拉——同一份缓存只自动试一次（没登录 sim 时别反复开标签页），
    // 拉到新的一份就是新的 30 天（Codex 10-12 第二轮 #8）
    const version = has ? cache.at : 0;
    if (!force && has && (!refDue(cache.at) || R.autoTriedFor === version)) { R.status = 'done'; return; }
    if (!force || !has || refDue(cache.at)) R.autoTriedFor = version;  // 过期的那份手动拉过（哪怕停了）也不再自动拉
    // 对比的基线：存着的那份满 30 天了就拿它当上一份；没满 30 天时手动重拉，基线还是原来那份，节奏不乱
    const prev = !has ? null : refDue(cache.at) ? { at: cache.at, domains: cache.items.map((x) => x.d) } : cache.prev || null;
    Object.assign(R, { status: 'loading', stopping: false, err: null, page: 0, pages: 0, got: 0, made: false });
    render();
    const t = await refTab();
    Object.assign(job, t);
    refTabJobs.set(t.tabId, job);
    if (!alive()) return;
    R.made = t.made;
    render();
    const tabId = t.tabId;
    // 每次读表都核对还是不是这张表：用户开着的那页可能中途跳到别的域名
    const read = async (timeout) => {
      const s = await refReady(tabId, timeout, alive);
      if (s && !isRefPage(s.href)) throw new Error('引荐页跳到别的页面了，已停止');
      return s;
    };
    // 页码框在新一页画出来时会先显示 1、过一会儿才变成真页码：
    // 等到页码框显示第 page 页、且连着两次读到同一张表，这一页才算定下来
    const settle = async (page) => {
      const until = Date.now() + PAGE_TIMEOUT;
      let last = null;
      for (;;) {
        if (!alive()) return null;
        const s = await read(Math.max(1000, until - Date.now()));
        if (!alive()) return null;
        if (s && s.cur === page && last && last.cur === page && last.rows[0]?.d === s.rows[0]?.d) return s;
        if (Date.now() > until) throw new Error(`页码对不上：应在第 ${page} 页，表上是第 ${s?.cur ?? '?'} 页`);
        last = s;
        await sleep(300);
      }
    };
    let s = await read(REF_WAIT);
    if (!alive()) return;
    if (!s) throw new Error('1 分钟内没在引荐页上读到表格');
    await sleep(PAGE_GAP);
    s = await read(PAGE_TIMEOUT);
    if (!alive()) return;
    if (s && s.cur !== 1 && !await refStep(tabId, 'first', s.href)) {  // 开着的那页翻到了后面：先回第 1 页
      if (!alive()) return;
      throw new Error('回第 1 页超时');
    }
    const items = [], seen = new Set();
    let page = 1, size = 0;
    for (;;) {
      s = await settle(page);
      if (!s) return;
      size ||= s.rows.length;
      s.rows.forEach((r, i) => {
        if (seen.has(r.d)) return;
        seen.add(r.d);
        items.push({ ...r, rank: (page - 1) * size + i + 1 });
      });
      Object.assign(R, { page, pages: s.pages, got: items.length });
      render();
      if (page >= s.pages || page >= REF_PAGE_CAP) break;
      await sleep(PAGE_GAP);
      if (!alive()) return;
      if (!await refStep(tabId, 'next', s.href)) {
        if (!alive()) return;
        throw new Error(`翻到第 ${page + 1} 页超时`);
      }
      page++;
    }
    // 表头写着一共多少个；读到的少了就照实说（多半是中途表格换了数据）
    const short = s.total && items.length < s.total ? `只读到 ${items.length} / ${s.total} 个` : '';
    const data = { items: items.filter((x) => !ignoredDomain(x.d)), at: Date.now(), total: s.total, short, prev };
    if (!alive()) return;
    // 写缓存这一下不能停（几毫秒）：开始写了，「停止」就不再生效，界面和存着的一定一致（Codex 10-12 第二轮 #5）
    job.committing = true;
    render();
    await chrome.storage.local.set({ [REF_CACHE]: data });
    Object.assign(R, refFrom(data), { status: 'done', err: null, filter: 'all' });
  } catch (e) {
    if (alive()) Object.assign(R, { status: R.items.length ? 'done' : 'error', err: e });
  } finally {
    await cleanupRefJob(job);
    if (refJob === job) refJob = null;
    finish();
    if (!job.cancelled) render();
  }
}

// 停止：这一轮作废，马上收拾标签页；等它退出后回到存着的那份。已经在写缓存了就不停（马上就写完）
async function stopRefs() {
  const job = refJob;
  if (!job || job.cancelled || job.committing) return;
  job.cancelled = true;
  R.stopping = true;
  render();
  cleanupRefJob(job);
  await job.finished;
  if (refJob) return;  // 已经开了新的一轮
  const cache = await refCache();
  if (refJob) return;
  if (cache?.items?.length) Object.assign(R, refFrom(cache), { status: 'done', err: null });
  else R.status = 'stopped';
  R.stopping = false;
  render();
}

const refPrevSet = () => (R.prev ? (R._prevSet?.src === R.prev ? R._prevSet.set : (R._prevSet = { src: R.prev, set: new Set(R.prev.domains) }).set) : null);
const refIsNew = (x) => { const p = refPrevSet(); return !!p && !p.has(x.d); };

// ---------- 找站：域龄（用户 10-12 同意资深用户的建议：从在收钱的站里找新站）----------
// 复用本机服务查注册日：先一次 20 个拿本机已经查过的（秒出），再 6 路并发查没查过的。
// 主机名先归到可注册域名（app.mailerfind.com → mailerfind.com）；托管子域（*.vercel.app 之类）不查。
// R.dom：主机名 → { d: 可注册域名, hosted }；R.reg：可注册域名 → { reg, source }

const refRegOf = (x) => { const m = R.dom[x.d]; return m && !m.hosted ? R.reg[m.d] : null; };
const refYoung = (x) => { const r = refRegOf(x); return !!r?.reg && ageMonths(r.reg) < 12; };

function agePill(x) {
  const m = R.dom[x.d];
  if (!m) return '';
  if (m.hosted) return `<span class="tag" title="托管在 ${esc(m.hosted)} 上，平台的注册日没有参考价值">托管</span>`;
  const r = R.reg[m.d];
  if (!r?.reg) return '';
  return `<span class="age" title="${esc(m.d)} 注册于 ${esc(r.reg)}（${esc(r.source)}）">${ageText(r.reg)}</span>`;
}

// 主机名统一成服务那边的写法再比：小写、去掉末尾的点、非 ASCII 转 punycode（café.com → xn--caf-dma.com）
function normHost(h) {
  try { return new URL(`http://${String(h).trim().replace(/\.$/, '')}/`).hostname; } catch { return String(h).toLowerCase(); }
}

async function lookupRefAges() {
  const items = R.items;
  // 这一份查完了就不再查；正在查的不重开；上次失败（多半服务没开）隔一分钟再试（Codex 10-12 第四轮 #6）
  // 查完的这一份：超过 3 天、而且有没查到注册日的，再问一遍（服务端的「没有」缓存也是 3 天）
  const stale = R.regFor === R.at && Date.now() - (R.regDoneAt || 0) > 3 * 86400000 && R.items.some((x) => R.dom[x.d] && !R.dom[x.d].hosted && !R.reg[R.dom[x.d].d]?.reg);
  if (!items.length || (R.regFor === R.at && !stale) || (R.regStatus === 'running' && R.regRunFor === R.at)) return;
  if (R.regErrFor === R.at && Date.now() - R.regErrAt < 60000) return;
  const at = R.at;
  const my = (R.regRun = (R.regRun || 0) + 1);
  const alive = () => my === R.regRun && R.at === at;
  Object.assign(R, { regStatus: 'running', regRunFor: at, regDone: 0, regTotal: 0, regErr: null });
  paintRefAges();
  try {
    // 服务一次最多归并 3000 个主机名：分批（第四轮 #8）
    const hosts = items.map((x) => normHost(x.d));
    const groups = [];
    for (let i = 0; i < hosts.length; i += 3000) {
      const r = await api('/normalize', { hosts: hosts.slice(i, i + 3000).map((h) => ({ h, via: 'link' })), pageHost: 'sim.3ue.co' });
      if (!alive()) return;
      groups.push(...r.items);
    }
    // 主机名 → 可注册域名：在归并结果里取能对上的最长那个
    const keys = [...new Set(groups.map((g) => g.domain))].sort((a, b) => b.length - a.length);
    const hostedOf = new Map(groups.map((g) => [g.domain, g.hosted]));
    const dom = {};
    for (const x of items) {
      const h = normHost(x.d);
      const d = keys.find((k) => h === k || h.endsWith('.' + k));
      dom[x.d] = d ? { d, hosted: hostedOf.get(d) || null } : null;
    }
    R.dom = dom;
    const look = [...new Set(Object.values(dom).filter((m) => m && !m.hosted).map((m) => m.d))];
    // 只长期留着查到的注册日；没查到的、出错的每一轮都重新问一遍（服务端自己按 3 天缓存「没有」）（第四轮 #5）
    for (const d of look) if (!R.reg[d]?.reg) delete R.reg[d];
    R.regTotal = look.length;
    for (let i = 0; i < look.length; i += 20) {
      const { results } = await api('/lookup', { domains: look.slice(i, i + 20), cachedOnly: true });
      if (!alive()) return;
      Object.assign(R.reg, results);
    }
    const todo = look.filter((d) => !R.reg[d]);
    R.regDone = look.length - todo.length;
    paintRefAges(true);
    let next = 0, down = null, failed = 0;
    const worker = async () => {
      while (next < todo.length && alive() && !down) {
        const d = todo[next++];
        try {
          const { results } = await api('/lookup', { domains: [d] });
          if (!alive()) return;
          if (results[d]?.transient) failed++;  // 服务那边限流、超时：算没查成，过会儿补（第五轮 #5）
          else Object.assign(R.reg, results);
        } catch (e) {
          if (!alive()) return;  // 旧的一轮出错不许写进新的一轮（第四轮 #3）
          if (e.down) { down = e; return; }
          R.reg[d] = { reg: null, source: e.message };
          failed++;
        }
        R.regDone++;
        paintRefAges();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (!alive()) return;
    if (down) throw down;
    // 有查失败的：这一份不算查完，过一分钟再补查那些（不然一次临时出错会挂 30 天）
    Object.assign(R, failed ? { regStatus: 'done', regErrFor: at, regErrAt: Date.now() } : { regStatus: 'done', regFor: at, regDoneAt: Date.now() });
  } catch (e) {
    if (!alive()) return;
    Object.assign(R, { regStatus: 'error', regErr: e, regErrFor: at, regErrAt: Date.now() });
  }
  paintRefAges(true);
}

// 查到一批就把列表里对应的胶囊换上（就地改，不重画整张表——重画会吞掉正好那一下的点击）；
// 最多 0.4 秒画一次。开着「1 年内注册」筛选时名单本身在变，才重画列表
let refPaintTimer = null;
function paintRefAges(now = false) {
  if (!now) { refPaintTimer ||= setTimeout(() => { refPaintTimer = null; paintRefAges(true); }, 400); return; }
  if (S.view !== 'refs' || R.status !== 'done') return;
  const young = R.items.filter(refYoung).length;
  const chip = view.querySelector('[data-act="r-young"]');
  if (chip) chip.innerHTML = `1 年内注册 ${young}`;
  const st = view.querySelector('#rregs');
  if (st) st.textContent = refRegText();
  if (R.young) return renderRefList();
  for (const el of view.querySelectorAll('#rlist .agecell')) {
    const html = agePill({ d: el.dataset.host });
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

const refRegText = () => (R.regStatus === 'running' ? `在查注册日 ${R.regDone} / ${R.regTotal || '…'}`
  : R.regStatus === 'error' ? (R.regErr?.down ? '没查注册日：本机查询服务没有响应' : `注册日没查完：${R.regErr?.message || ''}`) : '');

function refsShown() {
  const q = R.q.trim().toLowerCase();
  return R.items.filter((x) => (R.ind === 'all' || x.industry === R.ind) && (R.filter === 'all' || refIsNew(x)) && (!R.young || refYoung(x)) &&
    (!q || x.d.includes(q) || x.industry.toLowerCase().includes(q)));
}

// 第二行：域龄胶囊 + 行业（一行放不下就省略，「未知」不写）；全球排名放在份额下面
function refRow(x, no) {
  const ind = x.industry && x.industry !== '未知' ? x.industry : '';
  const rank = x.grank && x.grank !== '-' ? x.grank : '';
  return `<div class="hrow tall ref"><span class="c-rank" title="sim 表里第 ${esc(x.rank)} 名">${esc(no)}</span>
    <div class="kwcell"><span class="dname"><a class="ext" href="${esc(domainUrl(x.d))}" title="在 sim 看 ${esc(x.d)} 的新进关键词">${esc(x.d)}</a>
      <a class="ext site" href="https://${esc(x.d)}/" title="打开 ${esc(x.d)}" aria-label="打开 ${esc(x.d)}">${ICON_OPEN}</a>
      ${refIsNew(x) ? '<span class="badge new" title="上一份里没有">首次出现</span>' : ''}</span></div>
    <span class="c-share"><b>${esc(x.share)}</b>${rank ? `<small title="Similarweb 全球排名">全球 ${esc(rank)}</small>` : ''}</span>
    <div class="kwmeta one refmeta"${ind ? ` title="${esc(ind)}"` : ''}><span class="agecell" data-host="${esc(x.d)}">${agePill(x)}</span>${ind ? `<span>${esc(ind)}</span>` : ''}</div></div>`;
}

function renderRefList() {
  const shown = refsShown();
  const list = view.querySelector('#rlist');
  const count = view.querySelector('#rcount');
  if (count) count.textContent = `${shown.length} 个`;
  const copy = view.querySelector('[data-act="r-copy"]');
  if (copy) { copy.textContent = `复制 ${shown.length} 个`; copy.disabled = !shown.length; }
  const no = new Map(R.items.map((x, i) => [x.d, i + 1]));
  if (list) list.innerHTML = shown.map((x) => refRow(x, no.get(x.d))).join('') || '<div class="empty">没有符合条件的站。</div>';
}

const tsvCell = (v) => { let t = String(v ?? '').replace(/[\t\r\n]+/g, ' '); if (/^[=+\-@]/.test(t)) t = "'" + t; return t; };

// 复制下面正显示的这些站（按当前筛选），粘到表格里一行一个
async function copyRefs(btn) {
  const shown = refsShown();
  const no = new Map(R.items.map((x, i) => [x.d, i + 1]));
  const lines = ['名次\t域名\t变化\t行业\t全球排名\t占 Stripe 引荐\t注册日\t域龄'];
  for (const x of shown) {
    const m = R.dom[x.d], r = refRegOf(x);
    lines.push([no.get(x.d), x.d, refIsNew(x) ? '首次出现' : '', x.industry, x.grank === '-' ? '' : x.grank, x.share,
      m?.hosted ? `托管于 ${m.hosted}` : r?.reg || '', r?.reg ? ageText(r.reg) : ''].map(tsvCell).join('\t'));
  }
  await navigator.clipboard.writeText(lines.join('\n'));
  btn.textContent = `已复制 ${shown.length} 个`;
}

const REF_ABOUT = '把访客送进 checkout.stripe.com 的网站（= 在收钱的站）· sim 近 28 天 · 全球';

function renderRefs() {
  if (R.status === 'idle') { view.innerHTML = ''; loadRefs(); return; }
  // 同一个侧边栏开着跨过了 30 天：照样自动更新一次
  if (R.status === 'done' && refDue(R.at) && R.autoTriedFor !== R.at && !refJob) setTimeout(() => loadRefs(), 0);
  if (R.status === 'done' && (R.regFor !== R.at || Date.now() - (R.regDoneAt || 0) > 3 * 86400000)) setTimeout(() => lookupRefAges(), 0);
  const top = '<div class="list">';
  if (R.status === 'stopped') {
    view.innerHTML = `${top}<section class="card"><h2>已停止</h2><p>还没有存下来的 Stripe 引荐网站。</p>
      <button class="btn primary big" type="button" data-act="r-refresh">重新拉取</button></section></div>`;
    return;
  }
  if (R.status === 'error') {
    view.innerHTML = `${top}<section class="card err"><h2>${ICON_ALERT}没读到 Stripe 引荐网站</h2>
      <p>${esc(R.err?.message)}。先打开引荐页，看得到表格后这里会自动读取。</p>
      <div class="btns start"><a class="btn primary ext" href="${esc(REF_URL)}">打开引荐页</a>
      <button class="btn" type="button" data-act="r-refresh">重新读取</button></div></section></div>`;
    return;
  }
  let html = top;
  if (R.status === 'loading') {
    const pct = R.pages ? Math.round((R.page / R.pages) * 100) : 0;
    const where = R.stopping ? '正在停止…' : R.page ? `第 ${R.page} / ${R.pages} 页`
      : R.made ? '在后台开了一个 sim 引荐页，等表格出来…' : '等引荐页上的表格出来…';
    html += `<section class="status"><div class="stat-row"><div class="stat"><span class="big">${R.got}</span><span class="unit">个站</span></div>
      <button class="btn" type="button" data-act="r-stop"${R.stopping || refJob?.committing ? ' disabled' : ''}>${R.stopping ? '正在停止' : refJob?.committing ? '正在保存' : '停止'}</button></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meta">${where}</div></section>`;
    if (!R.items.length) { view.innerHTML = html + '</div>'; return; }
  }
  const inds = new Map();
  for (const x of R.items) if (x.industry) inds.set(x.industry, (inds.get(x.industry) || 0) + 1);
  if (R.ind !== 'all' && !inds.has(R.ind)) R.ind = 'all';
  const opts = ['<option value="all">全部行业</option>',
    ...[...inds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}"${R.ind === k ? ' selected' : ''}>${esc(k)} ${n}</option>`)].join('');
  const newN = R.prev ? R.items.filter(refIsNew).length : 0;
  const chip = (k, label, n) => `<button class="fbtn" type="button" data-act="r-filter" data-f="${k}" aria-pressed="${R.filter === k}"${n || k === 'all' ? '' : ' disabled'}>${label} ${n}</button>`;
  const md = (t) => new Date(t).toLocaleDateString('sv').slice(5);
  if (R.status !== 'loading') {
    html += `<section class="status"><div class="stat-row"><div class="stat"><span class="big">${R.items.length}</span><span class="unit">个站</span></div>
        <span class="btns"><button class="btn" type="button" data-act="r-copy" title="复制下面正显示的这些站（按当前筛选），粘到表格里一行一个">复制</button>
        <button class="btn" type="button" data-act="r-refresh" title="满 30 天自动重拉；点这里马上重拉">重新拉取</button></span></div>
      <div class="meta" title="${esc(REF_ABOUT)}">Stripe 引荐 · ${md(R.at)} 拉取 · ${refDue(R.at) ? '已满 30 天，下次打开侧边栏时再自动试' : `${md(R.at + REF_TTL)} 自动更新`}${R.short ? ` · ${esc(R.short)}` : ''}${R.err ? ` · 更新失败：${esc(R.err.message)}` : ''}</div>
      ${R.prev ? `<div class="diff"><span class="lbl">比 ${md(R.prev.at)}</span>${chip('all', '全部', R.items.length)}${chip('new', '首次出现', newN)}</div>`
        : ''}
      <div class="diff"><span class="lbl">域龄</span><button class="fbtn" type="button" data-act="r-young" aria-pressed="${!!R.young}" title="域名注册不到 1 年（本机服务查的注册日）">1 年内注册 ${R.items.filter(refYoung).length}</button>
        <span id="rregs">${esc(refRegText())}</span></div>
      </section>`;
  }
  html += `<div class="sticky"><div class="toolbar two"><input class="search" type="search" placeholder="搜域名或行业" value="${esc(R.q)}" aria-label="搜域名或行业" data-act="r-search">
      <select class="sel" data-act="r-ind" aria-label="按行业筛选">${opts}</select></div>
    <div class="colhead"><span class="c-rank">#</span><span class="c-kw">网站 · <span id="rcount"></span></span><span class="c-share">占 Stripe 引荐</span></div></div>
    <div id="rlist"></div></div>`;
  view.innerHTML = html;
  renderRefList();
}

// ================= 查域名：一个关键词的各种组合 × 常用后缀，注册了没有、哪天注册的 =================
// 用户 10-12 要的：给一个关键词，查它合理组合在 .com .net .org .ai .io .app .video 下的注册情况，
// 完整域名 + 注册时间，从近到远排（后来又加了 .wiki）。复用本机服务的 RDAP → whois；查「能不能注册」不用 3 天内的「没有」缓存（recheck）

const NAME_TLDS = ['com', 'net', 'org', 'ai', 'io', 'app', 'video', 'wiki'];  // wiki：用户 10-12 加
const NAME_STOP = new Set(['to', 'for', 'and', 'the', 'a', 'an', 'of', 'in', 'on', 'with', 'by', 'at', 'my', 'your']);
const N = { q: '', draft: '', status: 'idle', forms: [], rows: [], done: 0, run: 0 };

// 组合：连写、连字符、去掉 to / for / the 这类虚词（连写、连字符）、to → 2、for → 4
function nameForms(kw) {
  let t = kw.trim().toLowerCase();
  if (!/\s/.test(t)) t = t.replace(/\.[a-z]{2,}$/, '');  // 贴进来的是域名：去掉后缀
  const plain = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');  // é → e；中文等其他文字不硬转，整个不查
  if (/[^\x00-\x7f]/.test(plain)) return [];
  const words = plain.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  const add = (f) => { if (f && f.length <= 63 && !out.includes(f)) out.push(f); };
  const both = (ws) => { add(ws.join('')); if (ws.length > 1) add(ws.join('-')); };
  if (!words.length) return out;
  both(words);
  const core = words.filter((w) => !NAME_STOP.has(w));
  if (core.length && core.length < words.length) both(core);
  if (words.includes('to') && words.length > 1) add(words.map((w) => (w === 'to' ? '2' : w)).join(''));
  if (words.includes('for') && words.length > 1) add(words.map((w) => (w === 'for' ? '4' : w)).join(''));
  return out;
}

// 一个域名查到的结果归成四种：有注册日 / 注册了但不公开日期 / 没注册 / 没查成
function nameState(r) {
  if (!r) return 'pending';
  if (r.reg) return 'reg';
  if (r.free) return 'free';
  if (/不公开|无注册日/.test(r.source || '')) return 'hidden';
  return 'fail';
}

async function runNames(q) {
  const forms = nameForms(q);
  const my = ++N.run;
  const alive = () => my === N.run;
  Object.assign(N, { q, forms, status: forms.length ? 'running' : 'bad', done: 0, err: null,
    rows: forms.flatMap((f) => NAME_TLDS.map((t) => ({ d: `${f}.${t}`, r: null }))) });
  scrollTop('names');
  render();
  if (!forms.length) return;
  let next = 0, down = null;
  const worker = async () => {
    while (next < N.rows.length && alive() && !down) {
      const row = N.rows[next++];
      try {
        const { results } = await api('/lookup', { domains: [row.d], recheck: true });
        if (!alive()) return;
        row.r = results[row.d] || { reg: null, source: '没有结果' };
      } catch (e) {
        if (!alive()) return;
        if (e.down) { down = e; return; }
        row.r = { reg: null, source: e.message };
      }
      N.done++;
      render();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!alive()) return;
  Object.assign(N, down ? { status: 'error', err: down } : { status: 'done' });
  render();
}

// 注册日从近到远；注册了但不公开日期的、没查成的跟在后面，没注册的放最后
function namesSorted() {
  const rank = { reg: 0, hidden: 1, fail: 2, pending: 3, free: 4 };
  return [...N.rows].sort((a, b) => {
    const sa = nameState(a.r), sb = nameState(b.r);
    if (sa !== sb) return rank[sa] - rank[sb];
    return sa === 'reg' ? b.r.reg.localeCompare(a.r.reg) : 0;
  });
}

function nameRow(x) {
  const st = nameState(x.r);
  const name = st === 'free' ? `<div class="dname"><span>${esc(x.d)}</span></div>`
    : `<div class="dname"><a class="ext" href="${esc(domainUrl(x.d))}" title="在 sim 看 ${esc(x.d)} 的新进关键词">${esc(x.d)}</a>` +
      `<a class="ext site" href="https://${esc(x.d)}/" title="打开 ${esc(x.d)}" aria-label="打开 ${esc(x.d)}">${ICON_OPEN}</a></div>`;
  if (st === 'reg') return `<div class="drow">${name}<span class="c-reg" title="来源：${esc(x.r.source)}">${esc(x.r.reg)}</span><span class="c-age">${ageText(x.r.reg)}</span></div>`;
  const text = { pending: '查询中…', hidden: '已注册 · 不公开注册日', fail: '没查成', free: '未注册' }[st];
  return `<div class="drow${st === 'free' ? ' free' : ''}">${name}<span class="c-miss" title="${esc(x.r?.source || '')}">${text}</span></div>`;
}

function renderNames() {
  const count = (s) => N.rows.filter((x) => nameState(x.r) === s).length;
  let html = `<div class="list"><section class="status">
    <form class="namebar" data-act="n-form"><input class="search" type="search" data-act="n-input" placeholder="关键词，比如 pdf to jpg" value="${esc(N.draft)}" aria-label="关键词" autocomplete="off">
      <button class="btn primary" type="submit">查询</button></form>`;
  if (N.status === 'bad') html += '<div class="meta">只能查英文字母和数字组成的关键词。</div>';
  if (N.forms.length) {
    html += `<div class="meta">${N.forms.map(esc).join(' · ')} × .${NAME_TLDS.join(' .')}</div>`;
    html += `<div class="meta">${N.status === 'running' ? `查询中 ${N.done} / ${N.rows.length} · ` : ''}已注册 ${count('reg') + count('hidden')} · 未注册 ${count('free')}${count('fail') ? ` · 没查成 ${count('fail')}` : ''}</div>`;
  }
  html += '</section>';
  if (N.status === 'error' && N.err?.down) html += serviceDownCard('查注册日');
  if (N.rows.length) {
    html += '<div class="sticky"><div class="colhead"><span class="c-kw">域名</span><span class="c-reg">注册日</span><span class="c-age">域龄</span></div></div>';
    html += namesSorted().map(nameRow).join('');
  }
  view.innerHTML = html + '</div>';
}

// ---------- 事件 ----------

// 新标签页打开。先挂在收集用的那个标签页后面；那个标签页关了或挪到别的窗口时 Chrome 会拒绝，
// 就不带 opener 再开一次；还不行就用 window.open，并把原因写在面板顶上
async function openTab(url, background, opener) {
  const errors = [];
  if (opener != null) {
    try { await chrome.tabs.create({ url, active: !background, openerTabId: opener }); return; } catch (e) { errors.push(e.message); }
  }
  try { await chrome.tabs.create({ url, active: !background }); return; } catch (e) { errors.push(e.message); }
  if (!window.open(url, '_blank')) {
    view.insertAdjacentHTML('afterbegin', `<div class="ctxnote">打不开链接：${esc(errors.join('；'))}</div>`);
  }
}

// 结果里的链接一律新标签页打开；按住 ⌘/Ctrl 在后台打开
view.addEventListener('click', async (ev) => {
  const a = ev.target.closest('a.ext');
  if (a) {
    ev.preventDefault();
    openTab(a.href, ev.metaKey || ev.ctrlKey, S.view === 'hot' ? H.tabId : S.view === 'domains' ? D.tabId : null);
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const act = el.dataset.act;
  if (act === 'scan') runDomains();
  else if (act === 'retry') S.view === 'hot' ? probeHot() : S.view === 'names' ? runNames(N.q) : runDomains();
  else if (act === 'copy-cmd') { await navigator.clipboard.writeText(SERVICE_CMD); el.textContent = '已复制'; }
  else if (act === 'dom-filter') { D.filter = el.dataset.f; scrollTop('domains'); render(); }
  else if (act === 'dom-gone') { D.goneOpen = !D.goneOpen; render(); }
  else if (act === 'dom-copy') copyDomains(el);
  else if (act === 'go-domains') setView('domains');
  else if (act === 'collect') runCollect({ resume: false });
  else if (act === 'resume') runCollect({ resume: true });
  else if (act === 'stop') { H.stopReq = true; render(); }
  else if (act === 'hot-filter') { H.filter = el.dataset.f; scrollTop('hot'); render(); }
  else if (act === 'hot-gone') { H.goneOpen = !H.goneOpen; render(); }
  else if (act === 'export') exportHot();
  else if (act === 'w-refresh') loadWords({ force: true });
  else if (act === 'w-dir') { W.dir = el.dataset.f; scrollTop('words'); render(); }
  else if (act === 'w-group') { W.group = el.dataset.f; scrollTop('words'); render(); }
  else if (act === 'r-refresh') loadRefs({ force: true });
  else if (act === 'r-stop') stopRefs();
  else if (act === 'r-filter') { R.filter = el.dataset.f; scrollTop('refs'); render(); }
  else if (act === 'r-young') { R.young = !R.young; scrollTop('refs'); render(); }
  else if (act === 'r-copy') copyRefs(el);
});

view.addEventListener('input', (ev) => {
  if (ev.target.dataset.act === 'w-search') { W.q = ev.target.value; renderWordList(); }
  else if (ev.target.dataset.act === 'r-search') { R.q = ev.target.value; renderRefList(); }
  else if (ev.target.dataset.act === 'n-input') N.draft = ev.target.value;
});

view.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'dom-base') {
    await pickDomainBase(+el.value);
    render();
  } else if (el.dataset.act === 'r-ind') {
    R.ind = el.value; scrollTop('refs'); render();
  } else if (el.dataset.act === 'hot-base') {
    const job = H;
    await pickHotBase(job, +el.value);
    if (H === job) render();
  }
});

// 页签只切换视图；每个视图有自己的主按钮
$('#tab-domains').onclick = () => setView('domains');
$('#tab-words').onclick = () => setView('words');
$('#tab-refs').onclick = () => setView('refs');
$('#tab-names').onclick = () => { setView('names'); if (N.status === 'idle') view.querySelector('[data-act="n-input"]')?.focus(); };
// 查域名：回车或点「查询」
view.addEventListener('submit', (ev) => {
  if (ev.target.dataset.act !== 'n-form') return;
  ev.preventDefault();
  const q = ev.target.querySelector('[data-act="n-input"]').value;
  if (q.trim()) runNames(q);
});
$('#tab-hot').onclick = () => {
  if (!['running', 'done'].includes(H.status)) probeHot();
  setView('hot');
};

// 换了标签页、或页面跳转：顶栏跟着变；还没开始收集的「新进热词」重新看一下当前页。
// 当前标签页和网址都没变就不重画——重画会换掉整个列表，正好夹在按下和松开鼠标之间的那一下点击会丢
let lastTabKey = '';
async function onTabChange() {
  await refreshContext();
  const key = `${S.tab?.id}|${S.tab?.url}`;
  if (key === lastTabKey) return;
  lastTabKey = key;
  if (S.view === 'hot' && !['running', 'done'].includes(H.status)) probeHot();
  else {
    if (D.status === 'notsim' && isSim(S.tab)) D.status = 'idle';
    render();
  }
}
chrome.tabs.onActivated.addListener(onTabChange);
// 收集 / 扫描用的那个标签页关了：标记一下，结果照样留着
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === H.tabId) { H.tabGone = true; if (H.status === 'running') H.stopReq = true; }
  if (tabId === D.tabId) D.tabGone = true;
  render();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (S.tab && tabId === S.tab.id && (info.url || info.status === 'complete')) onTabChange();
  // 找站读不到时让用户先打开引荐页：那页一加载完就自动再读
  if (R.status === 'error' && info.status === 'complete' && isRefPage(tab?.url)) loadRefs({ force: true });
});
// 找词因为没登录 web.cafe 拿不到：登录完回到侧边栏就自动再试
window.addEventListener('focus', () => {
  if (S.view === 'refs' && R.status === 'done' && refDue(R.at)) render();  // 跨过 30 天：重画时会自动更新一次
  if (W.status === 'login' || (W.status === 'error' && !W.items.length)) loadWords({ force: true });
});

// 打开时按当前页面默认选一项：sim 关键词表 → 新进热词，其他 → 域名注册时间
(async () => {
  await refreshContext();
  lastTabKey = `${S.tab?.id}|${S.tab?.url}`;
  if (isSim(S.tab) && isKeywordPage(S.tab.url)) { probeHot(); setView('hot'); }
  else if (isSim(S.tab)) setView('domains');
  else setView('words');  // 不在 sim 上时，找词照样能用
})();
