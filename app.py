#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
radio.cn (云听/央广) HLS 签名代理 —— 纯标准库实现，零依赖。

播放地址形如:
    http://<host>:7680/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8

工作方式:
    1. 从请求的 url 中取出切片索引名 (index_40639.m3u8);
    2. 用 SIGN_KEY 调用 ytmsout.radio.cn 的 /web/appBroadcast/list 接口,
       sign = UPPER(MD5("categoryId=0&provinceCode=<省>&timestamp=<ms>&key=<SIGN_KEY>"));
    3. 拿到该频道的**新鲜**带 key/time 令牌的 m3u8 地址;
    4. 默认把 m3u8 内容代理回来并把相对切片路径改写为 CDN 绝对地址(玩家每次刷新
       播放列表都会重新走一遍这里 => 自动续签);mode=redirect 时直接 302。

切片(segment)本身不需要令牌,所以不占用本机带宽。
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 配置
SIGN_KEY = (os.environ.get("SIGN_KEY") or os.environ.get("RADIO_CN_SIGN_KEY") or "").strip()
API_BASE = (os.environ.get("API_BASE") or "https://ytmsout.radio.cn").rstrip("/")
PORT = int(os.environ.get("PORT") or 7680)
BIND = os.environ.get("BIND") or "0.0.0.0"
CATALOG_TTL = int(os.environ.get("CATALOG_TTL") or 900)   # 全量频道表刷新间隔(秒)
RESIGN_WINDOW = int(os.environ.get("RESIGN_WINDOW") or 30)  # 同一频道复用已签地址的最长时间(秒)
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT") or 8)
LOG_REQUESTS = (os.environ.get("LOG_REQUESTS") or "1") not in ("0", "false", "no")
UA = os.environ.get("UPSTREAM_UA") or (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
# 优先使用的播放地址字段:高码率 mp3 -> 多码率 -> 低码率 mp3 -> 低码率
PREFER_FIELDS = ("mp3PlayUrlHigh", "playUrlMulti", "mp3PlayUrlLow", "playUrlLow")
DEBUG = (os.environ.get("DEBUG") or "0") in ("1", "true", "yes")


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


# ---------------------------------------------------------------- 签名与 API
def _sign(params: str, ts: str) -> str:
    raw = (params + "&" if params else "") + "timestamp=%s&key=%s" % (ts, SIGN_KEY)
    return hashlib.md5(raw.encode("utf-8")).hexdigest().upper()


def api_get(path: str, params: str = "", retries: int = 2) -> dict:
    """调用 ytmsout 网关, 返回解析后的 JSON。"""
    last = None
    for attempt in range(retries + 1):
        ts = str(int(time.time() * 1000))
        url = API_BASE + path + (("?" + params) if params else "")
        req = urllib.request.Request(url, headers={
            "sign": _sign(params, ts),
            "timestamp": ts,
            "platformCode": "WEB",
            "equipmentId": "0000",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
                body = r.read().decode("utf-8", "replace")
            data = json.loads(body)
            if data.get("code") not in (0, None):
                raise RuntimeError("api code=%s message=%s" % (data.get("code"), data.get("message")))
            return data
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))
    raise RuntimeError("api %s failed: %s" % (path, last))


# ---------------------------------------------------------------- 频道目录缓存
def _basename(u: str) -> str:
    try:
        return urllib.parse.urlparse(u).path.rsplit("/", 1)[-1]
    except Exception:  # noqa: BLE001
        return ""


def _looks_like_radio_cn(u: str) -> bool:
    host = (urllib.parse.urlparse(u).hostname or "").lower()
    return host.endswith("radio.cn")


class Catalog:
    def __init__(self):
        self.lock = threading.RLock()
        self.provinces = []          # [(code, name)]
        self.items = {}              # code -> {"ts": float, "rows": [station, ...]}
        self.index = {}              # basename -> (code, contentId)
        self.full_ts = 0.0
        self.ready = threading.Event()
        self.building = False

    # -------- 基础抓取
    def _load_provinces(self):
        data = api_get("/web/appProvince/list/all")
        provs = []
        for p in data.get("data") or []:
            code = str(p.get("provinceCode"))
            if code == "None":
                continue
            provs.append((code, p.get("provinceName") or code))
        with self.lock:
            self.provinces = provs
        return provs

    def _refresh_province(self, code: str):
        data = api_get("/web/appBroadcast/list", "categoryId=0&provinceCode=%s" % code)
        rows = data.get("data") or []
        with self.lock:
            self.items[code] = {"ts": time.time(), "rows": rows}
            for st in rows:
                cid = str(st.get("contentId"))
                for f in PREFER_FIELDS:
                    b = _basename(st.get(f) or "")
                    if b:
                        self.index.setdefault(b, (code, cid))

    def build(self, force=False):
        with self.lock:
            if self.building:
                return
            if not force and self.full_ts and time.time() - self.full_ts < CATALOG_TTL:
                return
            self.building = True
        try:
            provs = self.provinces or self._load_provinces()
            if not provs:
                return
            errors = 0
            sem = threading.Semaphore(6)
            threads = []

            def work(c):
                nonlocal errors
                try:
                    with sem:
                        self._refresh_province(c)
                except Exception as e:  # noqa: BLE001
                    errors += 1
                    if DEBUG:
                        log("province %s failed: %s" % (c, e))

            for code, _name in provs:
                t = threading.Thread(target=work, args=(code,), daemon=True)
                t.start()
                threads.append(t)
            for t in threads:
                t.join(30)
            with self.lock:
                self.full_ts = time.time()
            self.ready.set()
            log("频道表已刷新: %d 个地区, %d 个切片索引, 失败 %d"
                % (len(provs), len(self.index), errors))
        finally:
            with self.lock:
                self.building = False

    def ensure_ready(self):
        if self.ready.is_set():
            return
        self.build()

    # -------- 查询
    def lookup(self, name: str):
        """name = index_40639.m3u8 ,返回 (code, contentId)"""
        with self.lock:
            hit = self.index.get(name)
        if hit:
            return hit
        self.ensure_ready()
        with self.lock:
            return self.index.get(name)

    def station(self, code: str, cid: str):
        """拿某地区下某频道的记录, 超过 RESIGN_WINDOW 就重抓该地区(即重新签一个新令牌)"""
        with self.lock:
            entry = self.items.get(code)
        if not entry or time.time() - entry["ts"] > RESIGN_WINDOW:
            self._refresh_province(code)
            with self.lock:
                entry = self.items.get(code)
        if not entry:
            return None
        for st in entry["rows"]:
            if str(st.get("contentId")) == str(cid):
                return st
        # 频道可能换号/下架, 重建一次索引再找
        self.build(force=True)
        with self.lock:
            entry = self.items.get(code)
        for st in (entry or {}).get("rows", []):
            if str(st.get("contentId")) == str(cid):
                return st
        return None

    def all_stations(self):
        self.ensure_ready()
        names = {c: n for c, n in self.provinces}
        out = []
        with self.lock:
            for code, entry in self.items.items():
                for st in entry["rows"]:
                    src = next((st.get(f) for f in PREFER_FIELDS if st.get(f)), "") or ""
                    # streams: 每个码率字段的索引文件名，方便按任意 basename 反查
                    streams = []
                    for f in PREFER_FIELDS:
                        b = _basename(st.get(f) or "")
                        if b and b not in streams:
                            streams.append(b)
                    out.append({
                        "title": st.get("title"),
                        "contentId": str(st.get("contentId")),
                        "province": names.get(code, code),
                        "provinceCode": code,
                        "subtitle": st.get("subtitle"),
                        "image": st.get("image"),
                        "streams": streams,
                        "source": src.split("?", 1)[0],
                        "index": _basename(src),
                    })
        out.sort(key=lambda x: (x["provinceCode"] != "0", x["province"], x["title"] or ""))
        return out


CATALOG = Catalog()


def pick_signed_url(station: dict, want_name: str) -> str:
    """在一条频道记录里挑出与请求索引名一致的新鲜地址, 否则按优先级回退。"""
    for f in PREFER_FIELDS:
        u = station.get(f) or ""
        if u and _basename(u) == want_name:
            return u
    for f in PREFER_FIELDS:
        u = station.get(f) or ""
        if u:
            return u
    return ""


def resolve_signed_url(target: str):
    """输入用户给的(可能已过期的)地址, 返回新的带签地址;非 radio.cn 直接透传。"""
    target = target.strip()
    if not target.lower().startswith(("http://", "https://")):
        if target.isdigit():
            target = "http://ytcast2.radio.cn/index_%s.m3u8" % target
        elif target.startswith("index_"):
            target = "http://ytcast2.radio.cn/%s" % target
        else:
            raise ValueError("url 参数不是合法地址")
    if not _looks_like_radio_cn(target):
        return target, None
    name = _basename(target)
    if not name:
        raise ValueError("无法从地址中解析出频道索引文件")
    hit = CATALOG.lookup(name)
    if not hit:
        raise LookupError("频道索引 %s 未在 radio.cn 目录中找到" % name)
    code, cid = hit
    st = CATALOG.station(code, cid)
    if not st:
        raise LookupError("频道 %s 无法续签(目录已变化)" % name)
    signed = pick_signed_url(st, name)
    if not signed:
        raise LookupError("频道 %s 没有可用的播放地址" % name)
    return signed, st


# ---------------------------------------------------------------- HLS 改写
_URI_ATTR = re.compile(r'(URI\s*=\s*)"([^"]*)"')


def rewrite_playlist(text: str, base: str) -> str:
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith("#"):
            def _rep(m):
                return '%s"%s"' % (m.group(1), urllib.parse.urljoin(base, m.group(2)))
            out.append(_URI_ATTR.sub(_rep, line))
        else:
            out.append(urllib.parse.urljoin(base, s))
    return "\n".join(out) + "\n"


def fetch_upstream(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": "https://www.radio.cn/",
    })
    with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
        return r.status, r.headers.get("Content-Type") or "", r.read(2_000_000)


# ---------------------------------------------------------------- HTTP 服务
class Handler(BaseHTTPRequestHandler):
    server_version = "radio-cn-sign/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 工具
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None, head=False):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head and body:
            self.wfile.write(body)

    def _send_json(self, code, obj, head=False):
        self._send(code, json.dumps(obj, ensure_ascii=False, indent=2),
                   "application/json; charset=utf-8", head=head)

    def log_message(self, fmt, *args):  # 精简访问日志
        if LOG_REQUESTS:
            log("%s %s" % (self.address_string(), fmt % args))

    # ---- 路由
    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        raw_qs = parsed.query

        if path in ("/", "/index.html"):
            return self._send(200, INDEX_HTML, "text/html; charset=utf-8", head=head)
        if path == "/healthz":
            return self._send_json(200, {
                "ok": True,
                "ready": CATALOG.ready.is_set(),
                "stations": len(CATALOG.index),
                "api": API_BASE,
            }, head=head)
        if path in ("/stations", "/stations.json"):
            return self._handle_stations(raw_qs, head)
        if path in ("/radio.m3u", "/list.m3u"):
            return self._handle_m3u(raw_qs, head)
        if path in ("/m3u8", "/live", "/hls", "/play"):
            return self._handle_m3u8(raw_qs, head)
        return self._send(404, "404 not found\n", head=head)

    # ---- /m3u8
    def _handle_m3u8(self, raw_qs: str, head=False):
        target, mode = self._parse_m3u8_query(raw_qs)
        if not target:
            return self._send_json(400, {
                "ok": False,
                "error": "缺少 url 参数",
                "example": "http://%s/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8"
                           % (self.headers.get("Host") or "127.0.0.1:7680"),
            }, head=head)
        started = time.time()
        try:
            signed, station = resolve_signed_url(target)
        except LookupError as e:
            return self._send_json(404, {"ok": False, "error": str(e), "url": target}, head=head)
        except ValueError as e:
            return self._send_json(400, {"ok": False, "error": str(e), "url": target}, head=head)
        except Exception as e:  # noqa: BLE001
            log("sign error: %s" % e)
            return self._send_json(502, {"ok": False, "error": "签名接口失败: %s" % e,
                                         "url": target}, head=head)

        title = (station or {}).get("title") or ""
        target_path = urllib.parse.urlparse(signed).path.lower()
        is_hls = target_path.endswith(".m3u8") or target_path.endswith(".m3u")
        # 直连 mp3 / 非 HLS 流: 不能缓冲代理, 直接 302 让播放器自己连
        if mode == "redirect" or not is_hls:
            return self._send(302, b"", "text/plain; charset=utf-8",
                              {"Location": signed, "Cache-Control": "no-store"}, head=head)

        try:
            status, ctype, body = fetch_upstream(signed)
        except Exception as e:  # noqa: BLE001
            log("upstream error: %s" % e)
            return self._send_json(502, {"ok": False, "error": "上游播放列表拉取失败: %s" % e,
                                         "url": target}, head=head)

        text = body.decode("utf-8", "replace")
        if "#EXTM3U" in text:
            out = rewrite_playlist(text, signed).encode("utf-8")
            ctype = "application/vnd.apple.mpegurl"
        else:  # 极少数情况:上游直接回了切片或 mp3
            out = body
            ctype = ctype or "application/octet-stream"
        if DEBUG:
            log("signed %s -> %s (%s, %d bytes, %.0f ms)"
                % (target, signed.split("?")[0], title, len(out), (time.time() - started) * 1000))
        return self._send(200, out, ctype, {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Station": urllib.parse.quote(title or ""),
        }, head=head)

    @staticmethod
    def _parse_m3u8_query(raw_qs: str):
        """宽松解析: url 里可能带未编码的 & , 所以不能直接用 parse_qs。"""
        mode = "proxy"
        qs = raw_qs
        m = re.search(r"(?:^|&)mode=([A-Za-z]+)(?=&|$)", qs)
        if m:
            mode = m.group(1).lower()
            qs = qs[:m.start()] + qs[m.end():]
        if qs.startswith("url="):
            qs = qs[4:]
        elif "&url=" in qs:
            qs = qs.split("&url=", 1)[1]
        elif qs.startswith("id="):
            qs = qs[3:]
        return urllib.parse.unquote(qs.strip()), mode

    # ---- /stations
    def _handle_stations(self, raw_qs: str, head=False):
        q = urllib.parse.parse_qs(raw_qs or "")
        prov = (q.get("province") or [""])[0]
        base = "http://%s/m3u8?url=" % (self.headers.get("Host") or "127.0.0.1:7680")
        try:
            rows = CATALOG.all_stations()
        except Exception as e:  # noqa: BLE001
            return self._send_json(502, {"ok": False, "error": str(e)}, head=head)
        out = []
        for r in rows:
            if prov and prov != "all" and r["provinceCode"] != prov:
                continue
            out.append({
                "title": r["title"],
                "province": r["province"],
                "contentId": r["contentId"],
                "proxy": base + (r["source"] or ("http://ytcast2.radio.cn/" + (r["index"] or ""))),
                "image": r["image"],
                "index": r["index"],
                "streams": r["streams"],
            })
        return self._send_json(200, {"ok": True, "count": len(out), "stations": out}, head=head)

    # ---- /radio.m3u
    def _handle_m3u(self, raw_qs: str, head=False):
        q = urllib.parse.parse_qs(raw_qs or "")
        prov = (q.get("province") or [""])[0]
        base = "http://%s/m3u8?url=" % (self.headers.get("Host") or "127.0.0.1:7680")
        try:
            rows = CATALOG.all_stations()
        except Exception as e:  # noqa: BLE001
            return self._send_json(502, {"ok": False, "error": str(e)}, head=head)
        lines = ["#EXTM3U"]
        seen = set()
        for r in rows:
            if prov and prov != "all" and r["provinceCode"] != prov:
                continue
            if not r["index"]:
                continue
            key = (r["title"], r["index"])
            if key in seen:
                continue
            seen.add(key)
            lines.append('#EXTINF:-1 tvg-name="%s" tvg-logo="%s" group-title="%s",%s'
                         % (r["title"] or "", r["image"] or "", r["province"] or "", r["title"] or ""))
            lines.append(base + (r["source"] or ("http://ytcast2.radio.cn/" + r["index"])))
        body = ("\n".join(lines) + "\n").encode("utf-8")
        return self._send(200, body, "audio/x-mpegurl; charset=utf-8",
                          {"Cache-Control": "no-store"}, head=head)


INDEX_HTML = """<!doctype html><meta charset="utf-8"><title>radio.cn 签名代理</title>
<style>body{font:15px/1.7 -apple-system,"Microsoft YaHei",sans-serif;margin:40px;max-width:820px}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style>
<h2>radio.cn 云听 HLS 签名代理</h2>
<p>用法:<br><code>http://HOST:7680/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8</code></p>
<p>可选参数:<code>&amp;mode=redirect</code> 返回 302 直连 CDN;默认代理播放列表并自动续签。</p>
<p><a href="/stations">/stations</a> 频道列表 · <a href="/radio.m3u">/radio.m3u</a> M3U 订阅 ·
<a href="/healthz">/healthz</a> 健康检查</p>
"""


def main():
    if not SIGN_KEY:
        raise SystemExit("缺少环境变量 SIGN_KEY")
    threading.Thread(target=lambda: CATALOG.build(force=True), daemon=True).start()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    log("listening on http://%s:%d  api=%s" % (BIND, PORT, API_BASE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
