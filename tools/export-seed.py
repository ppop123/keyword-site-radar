#!/usr/bin/env python3
"""把 Chrome 里这个插件已经拉到的「找词」「找站」数据导出成项目里带的那份（extension/seed/）。

插件第一次打开、本地还没有数据时先用这份（用户 10-12 要的）。想更新这份：在插件里拉一次新的，
然后跑 `python3 tools/export-seed.py`，提交 extension/seed/ 下的两个文件。

数据在 Chrome 的 `Local Extension Settings/<插件 ID>/`（LevelDB）。只读这一个插件的目录，
先复制到临时目录再读，不碰 Chrome 正在用的文件。只会读 .log（Chrome 还没压缩进 .ldb 的部分）——
读不到就说清楚，不硬猜。
"""
import glob
import json
import os
import shutil
import struct
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_DIR = os.path.join(ROOT, "extension")
CHROME = os.path.expanduser("~/Library/Application Support/Google/Chrome")
KEYS = {"webcafe-v2": "webcafe.json", "stripe-ref-v1": "stripe-ref.json"}


def find_extension():
    """按插件目录在各个 Chrome 用户的配置里找插件 ID，只看 extensions.settings 里的 path"""
    for prof in sorted(glob.glob(os.path.join(CHROME, "*", ""))):
        for fn in ("Secure Preferences", "Preferences"):
            try:
                with open(os.path.join(prof, fn)) as f:
                    settings = (json.load(f).get("extensions") or {}).get("settings") or {}
            except (OSError, ValueError):
                continue
            for eid, st in settings.items():
                if os.path.realpath(str(st.get("path", ""))) == os.path.realpath(EXT_DIR):
                    return prof, eid
    return None, None


def read_log(path):
    """LevelDB 的 .log：32KB 一块，每条记录 7 字节头（校验、长度、类型）；记录内容是 WriteBatch"""
    data = open(path, "rb").read()
    records, buf, i, B = [], b"", 0, 32768
    while i + 7 <= len(data):
        left = B - i % B
        if left < 7:
            i += left
            continue
        _, ln, typ = struct.unpack("<IHB", data[i:i + 7])
        i += 7
        if typ == 0 and ln == 0:  # 块尾补零
            i += B - i % B if i % B else 0
            continue
        frag, i = data[i:i + ln], i + ln
        if typ == 1:
            records.append(frag)
        elif typ == 2:
            buf = frag
        elif typ == 3:
            buf += frag
        elif typ == 4:
            records.append(buf + frag)
            buf = b""

    def varint(b, o):
        r = s = 0
        while True:
            c = b[o]
            o += 1
            r |= (c & 0x7F) << s
            s += 7
            if c < 0x80:
                return r, o

    latest = {}
    for r in records:
        _, count = struct.unpack("<QI", r[:12])
        o = 12
        for _ in range(count):
            tag = r[o]
            o += 1
            kl, o = varint(r, o)
            key, o = r[o:o + kl], o + kl
            if tag == 1:
                vl, o = varint(r, o)
                latest[key], o = r[o:o + vl], o + vl
            else:
                latest[key] = None
    return latest


def main():
    prof, eid = find_extension()
    if not eid:
        sys.exit(f"没在 Chrome 配置里找到加载自 {EXT_DIR} 的插件")
    src = os.path.join(prof, "Local Extension Settings", eid)
    with tempfile.TemporaryDirectory() as tmp:
        latest = {}
        for log in sorted(glob.glob(os.path.join(src, "*.log"))):
            dst = os.path.join(tmp, os.path.basename(log))
            shutil.copyfile(log, dst)
            latest.update(read_log(dst))
    os.makedirs(os.path.join(EXT_DIR, "seed"), exist_ok=True)
    missing = []
    for key, name in KEYS.items():
        raw = latest.get(key.encode())
        if not raw:
            missing.append(key)
            continue
        value = json.loads(raw)
        if not value.get("items"):
            missing.append(key)
            continue
        out = os.path.join(EXT_DIR, "seed", name)
        with open(out, "w") as f:
            json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{key} → extension/seed/{name}：{len(value['items'])} 条，拉取于 {value.get('at')}")
    if missing:
        ldb = glob.glob(os.path.join(src, "*.ldb"))
        sys.exit(f"没读到 {', '.join(missing)}" + ("（数据可能已被 Chrome 压缩进 .ldb，这个脚本读不了；在插件里重新拉一次再跑）" if ldb else "（插件里还没拉过？）"))


if __name__ == "__main__":
    main()
