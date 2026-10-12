#!/usr/bin/env python3
"""浏览助手本机服务：把页面上的主机名归并成可注册域名，再查注册日。

查询顺序：RDAP（IANA 引导表）→ whois 43 端口（先问 IANA 该问哪台）。
不用 AITDK 兜底：两者都查不到时多半是注册局不公开注册日（如 .de），这时 AITDK 的
「注册日」是最后修改日（spiegel.de 给 2021-07-26 = DENIC Changed），会冒充新域名。
查到的注册日永久缓存；查不到的 3 天后重查；网络出错的不缓存。
只监听 127.0.0.1，POST 必须带 X-Page-Helper: 1（网页发不出这个头而不触发预检）。
"""
import datetime
import json
import re
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VAR = ROOT / "var"
PSL_FILE = ROOT / "data" / "public_suffix_list.dat"
PORT = 8793
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")
MISS_TTL = 3 * 86400
BOOT_TTL = 7 * 86400
# 只在正文文字里出现、后缀又像文件扩展名的，多半是 readme.md / app.py 这类文件名
FILE_EXT_TLDS = {"md", "py", "zip", "mov"}


# ---------- 公共后缀表 ----------

NORMAL, WILD, EXC = {}, {}, {}


def _puny(rule):
    out = []
    for label in rule.split("."):
        if label.isascii():
            out.append(label)
        else:
            try:
                out.append(label.encode("idna").decode())
            except UnicodeError:
                return None
    return ".".join(out)


def _load_psl():
    private = False
    for line in PSL_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("// ===BEGIN PRIVATE DOMAINS==="):
            private = True
        if not line or line.startswith("//"):
            continue
        rule = line.split()[0].lower()
        table = NORMAL
        if rule.startswith("!"):
            table, rule = EXC, rule[1:]
        elif rule.startswith("*."):
            table, rule = WILD, rule[2:]
        rule = _puny(rule)
        if rule:
            table[rule] = private


def _suffix_len(labels, allow_private):
    """公共后缀占几个标签；没有任何规则匹配返回 0（即不认这个后缀）。"""
    def hit(table, key):
        return key in table and (allow_private or not table[key])
    n = len(labels)
    for i in range(n):
        cand = ".".join(labels[i:])
        if hit(EXC, cand):
            return n - i - 1
        if hit(NORMAL, cand):
            return n - i
        if i + 1 < n and hit(WILD, ".".join(labels[i + 1:])):
            return n - i
    return 0


def classify(host):
    """主机名 → (归并键, 托管平台或 None)；不是合法域名返回 None。

    普通站归并到可注册域名（tools.foo.com → foo.com）。
    托管子域（foo.vercel.app）单独成键，平台写在第二项，不查注册日。
    """
    host = _puny((host or "").strip().lower().rstrip("."))
    if not host:
        return None
    labels = host.split(".")
    if len(labels) < 2 or any(not x for x in labels):
        return None
    n = _suffix_len(labels, False)
    if n == 0 or n >= len(labels):
        return None
    m = _suffix_len(labels, True)
    if n < m < len(labels):
        return ".".join(labels[-(m + 1):]), ".".join(labels[-m:])
    if m == len(labels) and m > n + 1:
        # 主机名本身就是私有后缀（如 *.oaiusercontent.com 下的 demo.oaiusercontent.com）：
        # 算托管，平台记成它的可注册域名
        return host, ".".join(labels[-(n + 1):])
    return ".".join(labels[-(n + 1):]), None


def normalize(hosts, page_host):
    self_key = (classify(page_host) or (None,))[0]
    items = {}
    for x in hosts[:3000]:
        if not isinstance(x, dict) or not isinstance(x.get("h"), str):
            continue
        r = classify(x.get("h"))
        if not r:
            continue
        key, platform = r
        it = items.setdefault(key, {"domain": key, "hosted": platform,
                                    "hosts": set(), "via": set(), "n": 0})
        it["hosts"].add(x["h"].lower())
        it["via"].add(x.get("via") or "text")
        it["n"] += int(x.get("n") or 1)
    out = []
    for it in items.values():
        if it["via"] == {"text"} and not it["hosted"] and \
                it["domain"].rsplit(".", 1)[1] in FILE_EXT_TLDS:
            continue
        out.append({"domain": it["domain"], "hosted": it["hosted"],
                    "self": it["domain"] == self_key, "n": it["n"],
                    "via": sorted(it["via"]), "hosts": sorted(it["hosts"])[:8]})
    return out


# ---------- 缓存 ----------

_db_lock = threading.Lock()
_db = None


def _conn():
    global _db
    if _db is None:
        VAR.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(VAR / "cache.sqlite", check_same_thread=False)
        _db.execute("CREATE TABLE IF NOT EXISTS reg (domain TEXT PRIMARY KEY, "
                    "reg TEXT, source TEXT, checked_at INTEGER)")
    return _db


def cache_get(domain):
    with _db_lock:
        row = _conn().execute("SELECT reg, source, checked_at FROM reg WHERE domain=?",
                              (domain,)).fetchone()
    return row and {"reg": row[0], "source": row[1], "checked_at": row[2]}


def cache_put(domain, reg, source):
    with _db_lock:
        _conn().execute("INSERT OR REPLACE INTO reg VALUES (?,?,?,?)",
                        (domain, reg, source, int(time.time())))
        _conn().commit()


# ---------- 快照：每次查完存一份，下次拿来对比「上次以来的变化」 ----------

SNAP_KINDS = {"hot", "domains"}
SNAP_KEEP = 30  # 每张表（kind + key）保留最近 30 份；同一天只留最后一份


def _snap_table():
    _conn().execute("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "kind TEXT, key TEXT, family TEXT, label TEXT, created_at INTEGER, day TEXT, "
                    "coverage INTEGER, n INTEGER, items TEXT)")
    _conn().execute("CREATE INDEX IF NOT EXISTS snapshots_key ON snapshots (kind, key, created_at)")
    _conn().execute("CREATE INDEX IF NOT EXISTS snapshots_family ON snapshots (kind, family, created_at)")
    _conn().execute("CREATE TABLE IF NOT EXISTS seen (domain TEXT PRIMARY KEY, first_seen INTEGER)")


def snap_save(kind, key, family, label, coverage, items):
    """同一张表同一天只留最后一份（「再翻 50 页」收完会替换当天那份）。"""
    now = int(time.time())
    day = time.strftime("%Y-%m-%d", time.localtime(now))
    with _db_lock:
        _snap_table()
        try:  # 替换 = 删旧 + 插新，要么都成要么都不成
            _conn().execute("DELETE FROM snapshots WHERE kind=? AND key=? AND day=?", (kind, key, day))
            cur = _conn().execute(
                "INSERT INTO snapshots (kind, key, family, label, created_at, day, coverage, n, items) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (kind, key, family, label, now, day, coverage, len(items), json.dumps(items, ensure_ascii=False)))
            _conn().execute("DELETE FROM snapshots WHERE kind=? AND key=? AND id NOT IN "
                            "(SELECT id FROM snapshots WHERE kind=? AND key=? ORDER BY created_at DESC, id DESC LIMIT ?)",
                            (kind, key, kind, key, SNAP_KEEP))
            _conn().commit()
        except Exception:
            _conn().rollback()
            raise
        return cur.lastrowid


def _snap_rows(rows):
    return [{"id": r[0], "label": r[1], "created_at": r[2], "day": r[3], "coverage": r[4], "n": r[5]} for r in rows]


def snap_list(kind, key, family=None):
    """同一张表的快照（新→旧）；另附同一 family 下别的表（比如排序不同）的最近几份，用来提示「不能比」。"""
    with _db_lock:
        _snap_table()
        same = _conn().execute("SELECT id, label, created_at, day, coverage, n FROM snapshots "
                               "WHERE kind=? AND key=? ORDER BY created_at DESC, id DESC", (kind, key)).fetchall()
        other = []
        if family:
            other = _conn().execute("SELECT id, label, created_at, day, coverage, n FROM snapshots "
                                    "WHERE kind=? AND family=? AND key<>? ORDER BY created_at DESC LIMIT 5",
                                    (kind, family, key)).fetchall()
    return {"snapshots": _snap_rows(same), "others": _snap_rows(other)}


def snap_get(snap_id):
    with _db_lock:
        _snap_table()
        row = _conn().execute("SELECT items FROM snapshots WHERE id=?", (snap_id,)).fetchone()
    return json.loads(row[0]) if row else None


def seen_mark(domains):
    """记下每个域名第一次被看到的时间；返回 ({domain: first_seen}, 整张表最早的记录时间)。"""
    now = int(time.time())
    with _db_lock:
        _snap_table()
        try:
            for d in domains:
                _conn().execute("INSERT OR IGNORE INTO seen VALUES (?,?)", (d, now))
            _conn().commit()
        except Exception:
            _conn().rollback()
            raise
        q = ",".join("?" * len(domains))
        rows = _conn().execute(f"SELECT domain, first_seen FROM seen WHERE domain IN ({q})", domains).fetchall() \
            if domains else []
        since = _conn().execute("SELECT MIN(first_seen) FROM seen").fetchone()[0]
    return dict(rows), since


def _snap_args(req):
    kind, key = req.get("kind"), req.get("key")
    if kind not in SNAP_KINDS or not isinstance(key, str) or not 0 < len(key) <= 4000:
        raise ValueError("bad kind/key")
    family = req.get("family")
    if family is not None and (not isinstance(family, str) or len(family) > 4000):
        raise ValueError("bad family")
    return kind, key, family


# ---------- 数据源 ----------

class Transient(Exception):
    """网络出错、限流之类，下次还该重查，不进缓存。"""


def _get(url, timeout, accept=None):
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                timeout=timeout) as r:
        return r.read()


_boot = None
_boot_at = 0.0
_boot_lock = threading.Lock()


def _bootstrap():
    """IANA RDAP 引导表；常驻进程里每 7 天刷新一次，刷新失败沿用旧表。"""
    global _boot, _boot_at
    with _boot_lock:
        if _boot is not None and time.time() - _boot_at < BOOT_TTL:
            return _boot
        f = VAR / "rdap_dns.json"
        if not f.exists() or time.time() - f.stat().st_mtime > BOOT_TTL:
            try:
                data = _get("https://data.iana.org/rdap/dns.json", 30)
                json.loads(data)["services"]  # 先验形状再落盘
                f.write_bytes(data)
            except (OSError, ValueError, KeyError, TypeError) as e:
                if _boot is None and not f.exists():
                    raise Transient(f"RDAP 引导表下载失败 {type(e).__name__}")
        try:
            boot = {}
            for tlds, urls in json.loads(f.read_text())["services"]:
                url = next((u for u in urls if u.startswith("https:")), urls[0])
                for t in tlds:
                    boot[t.lower()] = url.rstrip("/") + "/"
        except (OSError, ValueError, KeyError, TypeError, IndexError) as e:
            if _boot is None:
                raise Transient(f"RDAP 引导表损坏 {type(e).__name__}")
            boot = _boot
        _boot, _boot_at = boot, time.time()
        return _boot


def _valid_date(y, mo, d):
    try:
        dt = datetime.date(y, mo, d)
    except (TypeError, ValueError):
        return None
    return dt.isoformat() if 1985 <= y <= 2100 else None


def rdap(domain):
    base = _bootstrap().get(domain.rsplit(".", 1)[1])
    if not base:
        return None, "RDAP 不覆盖该后缀"
    try:
        j = json.loads(_get(base + "domain/" + domain, 10, "application/rdap+json"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, "RDAP 404"
        raise Transient(f"RDAP HTTP {e.code}")
    except (OSError, ValueError) as e:
        raise Transient(f"RDAP {type(e).__name__}")
    if not isinstance(j, dict):
        raise Transient("RDAP 返回格式异常")
    events = j.get("events")
    for ev in events if isinstance(events, list) else []:
        if not isinstance(ev, dict) or ev.get("eventAction") != "registration":
            continue
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(ev.get("eventDate") or ""))
        d = m and _valid_date(*map(int, m.groups()))
        if d:
            return d, "RDAP"
    return None, "RDAP 无注册日"


_refer = {}
_refer_lock = threading.Lock()

# 字段名和日期必须在同一行：[ \t] 不跨行，免得空字段吞掉下一行的到期日
_CREATED = re.compile(
    r"(?im)^[ \t]*(?:creation date|created(?: on| date)?|registered(?: on| date)?|"
    r"registration (?:time|date)|domain registration date|record created|"
    r"domain record activated|commencement date)[ \t]*[.:]+[ \t]*(\S.*?)[ \t]*$")
_MON = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
# 明确「没有这个域名」
_NO_MATCH = re.compile(
    r"no match|not found|no data found|no entries found|no object found|"
    r"status:\s*(?:free|available)|is available|not registered|domain not exist", re.I)
# 明确是一条域名记录（只是没公开注册日，如 .de）
_IS_RECORD = re.compile(r"(?im)^[ \t]*domain(?: name)?[ \t]*:[ \t]*\S")


def _whois_query(server, q, timeout=10):
    """整次查询（连接 + 读完）最多 timeout 秒，超时抛 OSError。"""
    deadline = time.monotonic() + timeout
    chunks, size = [], 0
    with socket.create_connection((server, 43), timeout=timeout) as s:
        s.sendall((q + "\r\n").encode())
        while size < 200_000:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"whois {server} 超过 {timeout}s")
            s.settimeout(left)
            b = s.recv(8192)
            if not b:
                break
            chunks.append(b)
            size += len(b)
    return b"".join(chunks).decode("utf-8", "replace")


def _whois_server(tld):
    """问 IANA 该后缀的 whois 服务器。串行查、只缓存像样的回答，坏回答抛 Transient。"""
    with _refer_lock:
        if tld in _refer:
            return _refer[tld]
        txt = _whois_query("whois.iana.org", tld)
        if not re.search(rf"(?im)^domain:[ \t]*{re.escape(tld)}[ \t]*$", txt):
            raise Transient("IANA whois 回答异常")
        m = re.search(r"(?im)^[ \t]*(?:refer|whois):[ \t]*(\S+)", txt)
        _refer[tld] = m.group(1) if m else None
        return _refer[tld]


def _parse_date(s):
    m = re.search(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", s)
    if m:
        return _valid_date(*map(int, m.groups()))
    m = re.search(r"(\d{1,2})[-./ ]([A-Za-z]{3})[a-z]*[-./ ,]+(\d{4})", s)
    if m:
        return _valid_date(int(m.group(3)), _MON.get(m.group(2).lower()), int(m.group(1)))
    m = re.search(r"(\d{1,2})[-./](\d{1,2})[-./](\d{4})", s)  # 日.月.年
    if m:
        return _valid_date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    return None


def whois(domain):
    try:
        server = _whois_server(domain.rsplit(".", 1)[1])
        if not server:
            return None, "whois 无服务器"
        txt = _whois_query(server, domain)
    except OSError as e:
        raise Transient(f"whois {type(e).__name__}")
    for m in _CREATED.finditer(txt):
        d = _parse_date(m.group(1))
        if d:
            return d, "whois"
    if _NO_MATCH.search(txt):
        return None, "whois 无此域名"
    if _IS_RECORD.search(txt):
        return None, "whois 不公开注册日"
    # 既不是记录也不是「无此域名」：多半是报错、限流，下次再查
    raise Transient("whois 回答无法识别")


def _one(domain):
    notes, transient = [], False
    for fn in (rdap, whois):
        try:
            reg, note = fn(domain)
        except Transient as e:
            transient, reg, note = True, None, str(e)
        except Exception as e:  # 解析里没料到的情况：当临时错误，不缓存
            print(f"{fn.__name__}({domain}) 出错: {e!r}", file=sys.stderr)
            transient, reg, note = True, None, f"{fn.__name__} 出错"
        if reg:
            return domain, reg, note, False
        notes.append(note)
    return domain, None, "；".join(notes), transient


def _free(reg, note):
    """没注册：RDAP 404 或 whois 明说没有这个域名，而且哪边都没说「有记录、不公开」"""
    note = note or ""
    return not reg and ("RDAP 404" in note or "whois 无此域名" in note) and "不公开" not in note and "无注册日" not in note


def lookup(domains, cached_only=False, recheck=False):
    """cached_only：只回本机已经查过的，没查过的不联网、也不出现在结果里（找站先秒出已知的域龄）。
    recheck：没查到注册日的不用缓存、重新查（查域名能不能注册时，3 天前的「没有」不算数）"""
    out, todo, now = {}, [], time.time()
    for d in domains:
        row = cache_get(d)
        if row and (row["reg"] or (not recheck and now - row["checked_at"] < MISS_TTL)):
            out[d] = {"reg": row["reg"], "source": row["source"], "cached": True, "free": _free(row["reg"], row["source"])}
        else:
            todo.append(d)
    if cached_only:
        return out
    with ThreadPoolExecutor(6) as ex:
        for d, reg, note, transient in ex.map(_one, todo):
            if reg or not transient:
                cache_put(d, reg, note)
            out[d] = {"reg": reg, "source": note, "cached": False, "free": not transient and _free(reg, note)}
    return out


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        # 插件页面有 host_permissions 时一般不走 CORS；万一发了预检，也只放行插件来源
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Page-Helper")
            self.send_header("Access-Control-Allow-Methods", "POST")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        if self.headers.get("X-Page-Helper") != "1" or \
                (origin and not origin.startswith("chrome-extension://")):
            return self._send(403, {"error": "forbidden"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16_000_000:
            return self._send(413, {"error": "too large"})
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if not isinstance(req, dict):
            return self._send(400, {"error": "bad json"})
        try:
            if self.path == "/normalize":
                return self._send(200, {"items": normalize(req.get("hosts") or [],
                                                           req.get("pageHost") or "")})
            if self.path == "/lookup":
                domains = [d for d in req.get("domains") or [] if isinstance(d, str)][:20]
                return self._send(200, {"results": lookup(domains, req.get("cachedOnly") is True, req.get("recheck") is True)})
            if self.path.startswith("/snapshot/"):
                try:
                    if self.path == "/snapshot/get":
                        if not isinstance(req.get("id"), int):
                            raise ValueError("bad id")
                        return self._send(200, {"items": snap_get(req["id"])})
                    if self.path == "/snapshot/seen":
                        domains = [d for d in req.get("domains") or [] if isinstance(d, str) and len(d) <= 300][:3000]
                        seen, since = seen_mark(domains)
                        return self._send(200, {"seen": seen, "since": since})
                    kind, key, family = _snap_args(req)
                    if self.path == "/snapshot/list":
                        return self._send(200, snap_list(kind, key, family))
                    if self.path == "/snapshot/save":
                        items, coverage = req.get("items"), req.get("coverage")
                        if not isinstance(items, list) or len(items) > 100000 or \
                                not all(isinstance(x, dict) for x in items):
                            raise ValueError("bad items")
                        label = str(req.get("label") or "")[:300]
                        ok_int = isinstance(coverage, int) and not isinstance(coverage, bool) and 0 <= coverage < 2**31
                        return self._send(200, {"id": snap_save(kind, key, family, label,
                                                                 coverage if ok_int else None, items)})
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
        except Exception as e:
            print(f"{self.path} 出错: {e!r}", file=sys.stderr)
            return self._send(500, {"error": "internal"})
        self._send(404, {"error": "not found"})


def main():
    _load_psl()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"page-helper 服务已启动 http://127.0.0.1:{PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
