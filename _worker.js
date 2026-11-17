/**
 * radio.cn（云听/央广）HLS 签名网关 —— Cloudflare Worker 版
 *
 * 移植自 radio-cn-sign/app.py（Python 3.12 / ThreadingHTTPServer），行为保持一致：
 *   1. 从请求 url 里取出切片索引名（index_40639.m3u8）；
 *   2. 用 SIGN_KEY 调 ytmsout.radio.cn 的 /web/appBroadcast/list，
 *      sign = UPPER(MD5("categoryId=0&provinceCode=<省>&timestamp=<ms>&key=<SIGN_KEY>"))
 *   3. 拿到该频道**新鲜**的带 key/time 令牌的 m3u8 地址；
 *   4. 默认把 m3u8 代理回来并把相对切片路径改写成 CDN 绝对地址（播放器每次刷新列表
 *      都会重新走一遍这里 => 自动续签）；mode=redirect 时直接 302。
 *
 * 切片(segment)本身不需要令牌，所以不占用 Worker 出站流量。
 *
 * 与 Python 版的差异（都是运行环境逼出来的，行为等价）：
 *   - 没有线程：目录表改成「构建时生成静态快照」，运行时不再拉 32 个省；
 *   - 没有 hashlib.md5：Workers 的 WebCrypto 不提供 MD5，这里内联一份 RFC 1321。
 *
 * 环境变量（在 Cloudflare 后台 Settings → Variables 绑定，或 wrangler secret put）：
 *   SIGN_KEY        必填，云听的签名密钥
 *   API_BASE        可选，默认 https://ytmsout.radio.cn
 *   UPSTREAM_UA     可选，覆盖上游 User-Agent
 *   RESIGN_WINDOW   可选，多少秒后台换一次令牌（不阻塞请求），默认 120
 *   DEBUG           可选，"1" 打开详细日志
 */

const VERSION = "radio-cn-sign/2.0-worker";
// 每次改代码把这里更新一下：/healthz 会回显，用来确认线上跑的是哪一版
const BUILD = "2026-11-17T06:04Z";

// 优先使用的播放地址字段：高码率 mp3 -> 多码率 -> 低码率 mp3 -> 低码率
const PREFER_FIELDS = ["mp3PlayUrlHigh", "playUrlMulti", "mp3PlayUrlLow", "playUrlLow"];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  // 让前端能读到自定义头（否则 fetch 里看不见 X-Off-Air，区分不了「没节目」和「网关出错」）
  "Access-Control-Expose-Headers": "X-Off-Air, X-Station, Retry-After",
};

// ---------------------------------------------------------------- MD5 (RFC 1321)
// Workers 的 crypto.subtle 没有 MD5，只能自己实现。输入按 UTF-8 取字节。
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function md5(input) {
  const msg = new TextEncoder().encode(String(input));
  const bitLen = msg.length * 8;
  const total = ((msg.length + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const tmp = D;
      D = C; C = B;
      const x = (A + F + MD5_K[i] + M[g]) >>> 0;
      const s = MD5_S[i];
      B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  let out = "";
  for (const v of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) {
      out += ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return out;
}

function makeSign(params, ts, key) {
  const raw = (params ? params + "&" : "") + "timestamp=" + ts + "&key=" + key;
  return md5(raw).toUpperCase();
}

// ---------------------------------------------------------------- 小工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[radio-cn-sign]", ...a);

async function fetchT(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只读响应体开头 n 字节就断开。
 * 专给无限流（mp3 直播）用：绝不能用 arrayBuffer()/text() 把整个 body 读完，
 * 否则播放器那头一直推流，这边永远等不到结束，请求就挂死了。
 * 超时定时器覆盖「读 body」这一段，不只是拿到响应头。
 */
async function fetchHead(url, headers, n = 2048, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers, signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ctype = r.headers.get("Content-Type") || "";
    if (!r.body) return { status: r.status, ctype, buf: new Uint8Array(0) };

    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    try {
      while (got < n) {
        const { value, done } = await reader.read();
        if (done) break;
        const take = value.length > n - got ? value.subarray(0, n - got) : value;
        chunks.push(take);
        got += take.length;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 流已结束 */ }
    }

    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return { status: r.status, ctype, buf };
  } finally {
    clearTimeout(timer);
  }
}

function basename(u) {
  try {
    const p = new URL(u).pathname;
    return p.slice(p.lastIndexOf("/") + 1) || "";
  } catch {
    return "";
  }
}

function looksLikeRadioCn(u) {
  try {
    const h = (new URL(u).hostname || "").toLowerCase();
    return h === "radio.cn" || h.endsWith(".radio.cn");
  } catch {
    return false;
  }
}

const cfg = (env) => ({
  key: (env.SIGN_KEY || "").trim(),
  api: (env.API_BASE || "https://ytmsout.radio.cn").replace(/\/+$/, ""),
  ua: env.UPSTREAM_UA || DEFAULT_UA,
  resignWindow: Number(env.RESIGN_WINDOW || 120) * 1000,
  debug: env.DEBUG === "1" || env.DEBUG === "true",
});

// ---------------------------------------------------------------- 频道目录
// index: basename -> [provinceCode, contentId]
// items: provinceCode -> { at, rows }
const store = {
  provinces: [],       // [[code, name]]
  index: new Map(),    // basename -> [provinceCode, contentId]
  items: new Map(),    // provinceCode -> { at, rows }
  done: new Set(),     // 已建过索引的 provinceCode
  rebuiltAt: 0,
  lastError: "",
  lastPl: null,      // {url, text, at} probe 刚拉到的播放列表，供 /m3u8 复用
  building: null,
};

// 构建时抓好的频道目录（gen_catalog.py 生成）。
// 有它就不必在运行时拉 32 个省的列表：冷启动从 12 秒降到一次请求。
// 格式：省码:省名:basename|contentId,basename|contentId;省码:省名:...
// >>> 静态目录（gen_catalog.py 生成，勿手改）>>>
const STATIC_CATALOG_AT = "2026-11-17T05:33Z";
const STATIC_CATALOG =
  "0:国家:index_40639.m3u8|639,index_30639.m3u8|639,index_10639.m3u8|639,index_40640.m3u8|640,index_30640.m3u8|640,index_10640.m3u8|640,index_40692.m3u8|692,index_60692.m3u8|692,index_30692.m3u8|692,index_10692.m3u8|692,index_40641.m3u8|641,index_30641.m3u8|641,index_10641.m3u8|641,index_40653.m3u8|653,index_30653.m3u8|653,index_10653.m3u8|653,index_40648.m3u8|648,index_30648.m3u8|648,index_10648.m3u8|648,index_40645.m3u8|645,index_30645.m3u8|645,index_10645.m3u8|645,index_40642.m3u8|642,index_30642.m3u8|642,index_10642.m3u8|642,index_40643.m3u8|643,index_30643.m3u8|643,index_10643.m3u8|643,index_40644.m3u8|644,index_30644.m3u8|644,index_10644.m3u8|644,index_40646.m3u8|646,index_30646.m3u8|646,index_10646.m3u8|646,index_40647.m3u8|647,index_30647.m3u8|647,index_10647.m3u8|647,index_40649.m3u8|649,index_30649.m3u8|649,index_10649.m3u8|649,index_40650.m3u8|650,index_30650.m3u8|650,index_10650.m3u8|650,index_40651.m3u8|651,index_30651.m3u8|651,index_10651.m3u8|651,index_40654.m3u8|654,index_30654.m3u8|654,index_10654.m3u8|654,index_40655.m3u8|655,index_30655.m3u8|655,index_10655.m3u8|655,index_40664.m3u8|664,index_30664.m3u8|664,index_10664.m3u8|664,index_220734.m3u8|734,index_60734.m3u8|734,index_110734.m3u8|734,index_10734.m3u8|734;340000:安徽:index_23617.m3u8|3409,index_13616.m3u8|3409,stream_21364.mp3|1364,stream_11364.mp3|1364,index_11364.m3u8|1364,index_220600.m3u8|600,index_110600.m3u8|600,index_10600.m3u8|600,stream_20603.mp3|603,stream_10603.mp3|603,index_10603.m3u8|603,index_220606.m3u8|606,index_110606.m3u8|606,index_10606.m3u8|606,index_220605.m3u8|605,index_110605.m3u8|605,index_10605.m3u8|605,index_220604.m3u8|604,index_110604.m3u8|604,index_10604.m3u8|604,index_220602.m3u8|602,index_110602.m3u8|602,index_10602.m3u8|602,index_220607.m3u8|607,index_110607.m3u8|607,index_10607.m3u8|607,index_220601.m3u8|601,index_110601.m3u8|601,index_10601.m3u8|601,index_220599.m3u8|599,index_110599.m3u8|599,index_10599.m3u8|599,stream_21433.mp3|1433,stream_11433.mp3|1433,index_11433.m3u8|1433,stream_21277.mp3|1277,stream_11277.mp3|1277,index_11277.m3u8|1277,stream_23280.mp3|3280,stream_13280.mp3|3280,index_13280.m3u8|3280,stream_21328.mp3|1328,stream_11328.mp3|1328,index_11328.m3u8|1328,stream_21327.mp3|1327,stream_11327.mp3|1327,index_11327.m3u8|1327,stream_20941.mp3|941,stream_10941.mp3|941,index_10941.m3u8|941,stream_21199.mp3|1199,stream_11199.mp3|1199,index_11199.m3u8|1199,stream_11334.mp3|1334,index_11334.m3u8|1334,stream_11633.mp3|1633,index_11633.m3u8|1633,stream_20946.mp3|946,stream_10946.mp3|946,index_10946.m3u8|946,stream_12165.mp3|2165,index_12165.m3u8|2165,stream_20951.mp3|951,stream_10951.mp3|951,index_10951.m3u8|951,stream_20944.mp3|944,stream_10944.mp3|944,index_10944.m3u8|944,stream_22559.mp3|2559,index_12559.m3u8|2559,stream_21197.mp3|1197,stream_11197.mp3|1197,index_11197.m3u8|1197,stream_12487.mp3|2487,stream_22487.mp3|2487,index_22487.m3u8|2487,stream_22488.mp3|2488,stream_12488.mp3|2488,index_12488.m3u8|2488,stream_21337.mp3|1337,stream_11337.mp3|1337,index_11337.m3u8|1337,stream_21343.mp3|1343,stream_11343.mp3|1343,index_11343.m3u8|1343,stream_22163.mp3|2163,stream_12163.mp3|2163,index_12163.m3u8|2163,stream_22162.mp3|2162,stream_12162.mp3|2162,index_12162.m3u8|2162,stream_11890.mp3|1890,index_11890.m3u8|1890,stream_20948.mp3|948,stream_10948.mp3|948,index_10948.m3u8|948,stream_21196.mp3|1196,stream_11196.mp3|1196,index_11196.m3u8|1196,stream_20950.mp3|950,stream_10950.mp3|950,index_10950.m3u8|950,stream_20945.mp3|945,stream_10945.mp3|945,index_10945.m3u8|945,stream_20940.mp3|940,stream_10940.mp3|940,index_10940.m3u8|940,stream_21198.mp3|1198,stream_11198.mp3|1198,index_11198.m3u8|1198,stream_20938.mp3|938,stream_10938.mp3|938,index_10938.m3u8|938,stream_21739.mp3|1739,stream_11739.mp3|1739,index_11739.m3u8|1739,stream_21740.mp3|1740,stream_11740.mp3|1740,index_11740.m3u8|1740,stream_21738.mp3|1738,stream_11738.mp3|1738,index_11738.m3u8|1738;110000:北京:index_220357.m3u8|357,index_110357.m3u8|357,index_10357.m3u8|357,index_220354.m3u8|354,index_110354.m3u8|354,index_10354.m3u8|354,index_220356.m3u8|356,index_110356.m3u8|356,index_10356.m3u8|356,stream_21255.mp3|1255,stream_11255.mp3|1255,index_11255.m3u8|1255,stream_11254.mp3|1254,index_11254.m3u8|1254;500000:重庆:stream_22552.mp3|2552,stream_12552.mp3|2552,index_12552.m3u8|2552,stream_21697.mp3|1697,stream_11697.mp3|1697,index_11697.m3u8|1697,index_40376.m3u8|376,index_30376.m3u8|376,index_10376.m3u8|376,index_220372.m3u8|372,index_110372.m3u8|372,index_10372.m3u8|372,stream_23273.mp3|3273,stream_13273.mp3|3273,index_13273.m3u8|3273,stream_20714.mp3|714,stream_10714.mp3|714,index_10714.m3u8|714,stream_21478.mp3|1478,stream_11478.mp3|1478,index_11478.m3u8|1478,stream_21451.mp3|1451,stream_11451.mp3|1451,index_11451.m3u8|1451,stream_22558.mp3|2558,stream_12558.mp3|2558,index_12558.m3u8|2558;350000:福建:stream_23343.mp3|3343,stream_13343.mp3|3343,index_13343.m3u8|3343,index_23377.m3u8|3358,index_13376.m3u8|3358,index_23493.m3u8|3384,index_13492.m3u8|3384,index_23571.m3u8|3399,index_13570.m3u8|3399,index_23631.m3u8|3418,index_13630.m3u8|3418,index_23699.m3u8|3429,index_13698.m3u8|3429,index_23733.m3u8|3442,index_13732.m3u8|3442,stream_23311.mp3|3311,stream_13311.mp3|3311,index_13311.m3u8|3311,index_40472.m3u8|472,index_30472.m3u8|472,index_10472.m3u8|472,index_220474.m3u8|474,index_110474.m3u8|474,index_10474.m3u8|474,index_220473.m3u8|473,index_110473.m3u8|473,index_10473.m3u8|473,index_220470.m3u8|470,index_110470.m3u8|470,index_10470.m3u8|470,stream_21206.mp3|1206,stream_11206.mp3|1206,index_11206.m3u8|1206,stream_20960.mp3|960,stream_10960.mp3|960,index_10960.m3u8|960,stream_20955.mp3|955,stream_10955.mp3|955,index_10955.m3u8|955,stream_20963.mp3|963,stream_10963.mp3|963,index_10963.m3u8|963,stream_22532.mp3|2532,stream_12532.mp3|2532,index_12532.m3u8|2532,stream_22237.mp3|2237,stream_12237.mp3|2237,index_12237.m3u8|2237,stream_21513.mp3|1513,stream_11513.mp3|1513,index_11513.m3u8|1513,stream_21892.mp3|1892,stream_11892.mp3|1892,index_11892.m3u8|1892,stream_21205.mp3|1205,stream_11205.mp3|1205,index_11205.m3u8|1205,stream_20959.mp3|959,stream_10959.mp3|959,index_10959.m3u8|959,stream_20968.mp3|968,stream_10968.mp3|968,index_10968.m3u8|968,stream_21484.mp3|1484,stream_11484.mp3|1484,index_11484.m3u8|1484,stream_21483.mp3|1483,stream_11483.mp3|1483,index_11483.m3u8|1483;620000:甘肃:stream_20751.mp3|751,stream_10751.mp3|751,index_10751.m3u8|751,index_220483.m3u8|483,index_110483.m3u8|483,index_10483.m3u8|483,index_220486.m3u8|486,index_110486.m3u8|486,index_10486.m3u8|486,index_220482.m3u8|482,index_110482.m3u8|482,index_10482.m3u8|482,stream_21143.mp3|1143,stream_11143.mp3|1143,index_11143.m3u8|1143,stream_21144.mp3|1144,stream_11144.mp3|1144,index_11144.m3u8|1144,stream_21141.mp3|1141,stream_11141.mp3|1141,index_11141.m3u8|1141,stream_21139.mp3|1139,stream_11139.mp3|1139,index_11139.m3u8|1139,stream_21900.mp3|1900,stream_11900.mp3|1900,index_11900.m3u8|1900,stream_11672.mp3|1672,index_11672.m3u8|1672,stream_21389.mp3|1389,stream_11389.mp3|1389,index_11389.m3u8|1389,index_21388.m3u8|1388,index_11388.m3u8|1388,stream_21390.mp3|1390,stream_11390.mp3|1390,index_11390.m3u8|1390,stream_22538.mp3|2538,stream_12538.mp3|2538,index_12538.m3u8|2538,stream_21138.mp3|1138,stream_11138.mp3|1138,index_11138.m3u8|1138;440000:广东:stream_23339.mp3|3339,stream_13339.mp3|3339,index_13339.m3u8|3339,index_23393.m3u8|3363,index_13392.m3u8|3363,index_23427.m3u8|3367,index_13426.m3u8|3367,index_23429.m3u8|3370,index_13428.m3u8|3370,index_23489.m3u8|3381,index_13488.m3u8|3381,index_23605.m3u8|3406,index_13604.m3u8|3406,index_23533.m3u8|2120798772572446720,index_13532.m3u8|2120798772572446720,index_220491.m3u8|491,index_110491.m3u8|491,index_10491.m3u8|491,index_220488.m3u8|488,index_110488.m3u8|488,index_10488.m3u8|488,index_220495.m3u8|495,index_110495.m3u8|495,index_10495.m3u8|495,index_220494.m3u8|494,index_110494.m3u8|494,index_10494.m3u8|494,index_220490.m3u8|490,index_110490.m3u8|490,index_10490.m3u8|490,index_220487.m3u8|487,index_110487.m3u8|487,index_10487.m3u8|487,index_220489.m3u8|489,index_110489.m3u8|489,index_10489.m3u8|489,index_220492.m3u8|492,index_110492.m3u8|492,index_10492.m3u8|492,index_220493.m3u8|493,index_110493.m3u8|493,index_10493.m3u8|493,index_220730.m3u8|730,index_110730.m3u8|730,index_10730.m3u8|730,stream_20731.mp3|731,stream_10731.mp3|731,index_10731.m3u8|731,index_220729.m3u8|729,index_110729.m3u8|729,index_10729.m3u8|729,index_220728.m3u8|728,index_110728.m3u8|728,index_10728.m3u8|728,index_220497.m3u8|497,index_110497.m3u8|497,index_10497.m3u8|497,index_220499.m3u8|499,index_110499.m3u8|499,index_10499.m3u8|499,index_220498.m3u8|498,index_110498.m3u8|498,index_10498.m3u8|498,stream_22193.mp3|2193,stream_12193.mp3|2193,index_12193.m3u8|2193,stream_22254.mp3|2254,stream_12254.mp3|2254,index_12254.m3u8|2254,stream_22194.mp3|2194,stream_12194.mp3|2194,index_12194.m3u8|2194,stream_11849.mp3|1849,index_11849.m3u8|1849,stream_11850.mp3|1850,index_11850.m3u8|1850,stream_11351.mp3|1351,index_11351.m3u8|1351,stream_11067.mp3|1067,index_11067.m3u8|1067,stream_22013.mp3|2013,stream_12013.mp3|2013,index_12013.m3u8|2013,stream_22012.mp3|2012,stream_12012.mp3|2012,index_12012.m3u8|2012,stream_21846.mp3|1846,stream_11846.mp3|1846,index_11846.m3u8|1846,stream_21845.mp3|1845,stream_11845.mp3|1845,index_11845.m3u8|1845,stream_21464.mp3|1464,stream_11464.mp3|1464,index_11464.m3u8|1464,stream_21986.mp3|1986,stream_11986.mp3|1986,index_11986.m3u8|1986,stream_22443.mp3|2443,stream_12443.mp3|2443,index_12443.m3u8|2443,stream_11899.mp3|1899,index_11899.m3u8|1899,stream_11063.mp3|1063,index_11063.m3u8|1063,stream_23294.mp3|3294,stream_13294.mp3|3294,index_13294.m3u8|3294,stream_22195.mp3|2195,stream_12195.mp3|2195,index_12195.m3u8|2195,stream_11076.mp3|1076,index_11076.m3u8|1076,stream_11068.mp3|1068,index_11068.m3u8|1068,stream_21424.mp3|1424,stream_11424.mp3|1424,index_11424.m3u8|1424,stream_11844.mp3|1844,index_11844.m3u8|1844,stream_21421.mp3|1421,stream_11421.mp3|1421,index_11421.m3u8|1421,stream_23285.mp3|3285,stream_13285.mp3|3285,index_13285.m3u8|3285,stream_21062.mp3|1062,stream_11062.mp3|1062,index_11062.m3u8|1062,stream_21539.mp3|1539,stream_11539.mp3|1539,index_11539.m3u8|1539,stream_21646.mp3|1646,stream_11646.mp3|1646,index_11646.m3u8|1646,stream_21064.mp3|1064,stream_11064.mp3|1064,index_11064.m3u8|1064;450000:广西:index_23373.m3u8|3357,index_13372.m3u8|3357,stream_21366.mp3|1366,stream_11366.mp3|1366,index_11366.m3u8|1366,index_220589.m3u8|589,index_110589.m3u8|589,index_10589.m3u8|589,index_220587.m3u8|587,index_110587.m3u8|587,index_20587.m3u8|587,index_220585.m3u8|585,index_110585.m3u8|585,index_10585.m3u8|585,index_40586.m3u8|586,index_30586.m3u8|586,index_10586.m3u8|586,index_220590.m3u8|590,index_110590.m3u8|590,index_10590.m3u8|590,stream_21650.mp3|1650,stream_11650.mp3|1650,index_11650.m3u8|1650,stream_21093.mp3|1093,stream_11093.mp3|1093,index_11093.m3u8|1093,stream_21913.mp3|1913,stream_11913.mp3|1913,index_11913.m3u8|1913,stream_11078.mp3|1078,index_11078.m3u8|1078,stream_11080.mp3|1080,index_11080.m3u8|1080,stream_11077.mp3|1077,index_11077.m3u8|1077,stream_21081.mp3|1081,stream_11081.mp3|1081,index_11081.m3u8|1081,stream_11083.mp3|1083,index_11083.m3u8|1083,stream_11449.mp3|1449,index_11449.m3u8|1449,stream_21372.mp3|1372,stream_11372.mp3|1372,index_11372.m3u8|1372,stream_21373.mp3|1373,stream_11373.mp3|1373,index_11373.m3u8|1373,stream_21651.mp3|1651,stream_11651.mp3|1651,index_11651.m3u8|1651,stream_21652.mp3|1652,stream_11652.mp3|1652,index_11652.m3u8|1652,stream_12392.mp3|2392,index_12392.m3u8|2392;520000:贵州:index_23363.m3u8|3356,index_13362.m3u8|3356,index_23507.m3u8|2120798756248170496,index_13506.m3u8|2120798756248170496,stream_20748.mp3|748,stream_10748.mp3|748,index_10748.m3u8|748,index_23695.m3u8|433,index_13694.m3u8|433,stream_21700.mp3|1700,stream_11700.mp3|1700,index_11700.m3u8|1700,index_220435.m3u8|435,index_110435.m3u8|435,index_10435.m3u8|435,index_220438.m3u8|438,index_110438.m3u8|438,index_10438.m3u8|438,stream_21119.mp3|1286,stream_11119.mp3|1286,index_11119.m3u8|1286,stream_11605.mp3|1605,index_11605.m3u8|1605,stream_21854.mp3|1854,stream_11854.mp3|1854,index_11854.m3u8|1854,stream_11118.mp3|1118,index_11118.m3u8|1118,stream_21659.mp3|1659,stream_11659.mp3|1659,index_11659.m3u8|1659,stream_21660.mp3|1660,stream_11660.mp3|1660,index_11660.m3u8|1660,stream_22542.mp3|2542,stream_12542.mp3|2542,index_12542.m3u8|2542;460000:海南:stream_23340.mp3|3340,stream_13340.mp3|3340,index_13340.m3u8|3340,index_220542.m3u8|542,index_110542.m3u8|542,index_10542.m3u8|542,index_220541.m3u8|541,index_110541.m3u8|541,index_10541.m3u8|541,index_220543.m3u8|543,index_110543.m3u8|543,index_10543.m3u8|543,stream_21097.mp3|1097,stream_11097.mp3|1097,index_11097.m3u8|1097,stream_21915.mp3|1915,stream_11915.mp3|1915,index_11915.m3u8|1915,stream_21095.mp3|1095,stream_11095.mp3|1095,index_11095.m3u8|1095,stream_21098.mp3|1098,stream_11098.mp3|1098,index_11098.m3u8|1098,stream_21096.mp3|1096,stream_11096.mp3|1096,index_11096.m3u8|1096,stream_21876.mp3|1876,stream_11876.mp3|1876,index_11876.m3u8|1876;130000:河北:index_23361.m3u8|3355,index_13360.m3u8|3355,index_23387.m3u8|3361,index_13386.m3u8|3361,index_23423.m3u8|3365,index_13422.m3u8|3365,index_23431.m3u8|3368,index_13430.m3u8|3368,index_23437.m3u8|3369,index_13436.m3u8|3369,index_23485.m3u8|3382,index_13484.m3u8|3382,index_23501.m3u8|3386,index_13500.m3u8|3386,index_23541.m3u8|3396,index_13540.m3u8|3396,index_23569.m3u8|3397,index_13568.m3u8|3397,index_23583.m3u8|3402,index_13582.m3u8|3402,index_23641.m3u8|3413,index_13640.m3u8|3413,index_23627.m3u8|3416,index_13626.m3u8|3416,index_23675.m3u8|3423,index_13674.m3u8|3423,index_23531.m3u8|2120798770592653312,index_13530.m3u8|2120798770592653312,stream_20745.mp3|745,stream_10745.mp3|745,index_10745.m3u8|745,stream_21453.mp3|1453,stream_11453.mp3|1453,index_11453.m3u8|1453,index_23395.m3u8|378,index_13394.m3u8|378,index_23435.m3u8|382,index_13434.m3u8|382,index_23439.m3u8|383,index_13438.m3u8|383,stream_12132.mp3|2132,index_12132.m3u8|2132,stream_23335.mp3|3335,stream_13335.mp3|3335,index_13335.m3u8|3335,stream_23337.mp3|3337,stream_13337.mp3|3337,index_13337.m3u8|3337,index_220380.m3u8|380,index_110380.m3u8|380,index_10380.m3u8|380,stream_21430.mp3|1430,stream_11430.mp3|1430,index_11430.m3u8|1430,index_220381.m3u8|381,index_110381.m3u8|381,index_10381.m3u8|381,stream_22070.mp3|2070,stream_12070.mp3|2070,index_12070.m3u8|2070,stream_23275.mp3|3275,stream_13275.mp3|3275,index_13275.m3u8|3275,stream_20777.mp3|777,stream_10777.mp3|777,index_10777.m3u8|777,stream_20770.mp3|770,stream_10770.mp3|770,index_10770.m3u8|770,stream_11219.mp3|1219,index_11219.m3u8|1219,index_220386.m3u8|386,index_110386.m3u8|386,index_10386.m3u8|386,index_220385.m3u8|385,index_110385.m3u8|385,index_10385.m3u8|385,stream_23292.mp3|3292,stream_13292.mp3|3292,index_13292.m3u8|3292,stream_21213.mp3|1213,stream_11213.mp3|1213,index_11213.m3u8|1213,stream_11214.mp3|1214,index_11214.m3u8|1214,stream_20782.mp3|782,stream_10782.mp3|782,index_10782.m3u8|782,stream_21217.mp3|1217,stream_11217.mp3|1217,index_11217.m3u8|1217,stream_21544.mp3|1544,stream_11544.mp3|1544,index_11544.m3u8|1544,stream_21542.mp3|1542,stream_11542.mp3|1542,index_11542.m3u8|1542,stream_21543.mp3|1543,stream_11543.mp3|1543,index_11543.m3u8|1543,stream_23304.mp3|3304,stream_13304.mp3|3304,index_13304.m3u8|3304,stream_21222.mp3|1222,stream_11222.mp3|1222,index_11222.m3u8|1222,stream_20775.mp3|775,stream_10775.mp3|775,index_10775.m3u8|775,stream_20783.mp3|783,stream_10783.mp3|783,index_10783.m3u8|783,stream_20781.mp3|781,stream_10781.mp3|781,index_10781.m3u8|781,stream_21493.mp3|1493,stream_11493.mp3|1493,index_11493.m3u8|1493,index_220390.m3u8|390,index_110390.m3u8|390,index_10390.m3u8|390,index_220389.m3u8|389,index_110389.m3u8|389,index_10389.m3u8|389,index_220388.m3u8|388,index_110388.m3u8|388,index_10388.m3u8|388,stream_23303.mp3|3303,stream_13303.mp3|3303,index_13303.m3u8|3303,stream_21710.mp3|1710,stream_11710.mp3|1710,index_11710.m3u8|1710,stream_21709.mp3|1709,stream_11709.mp3|1709,index_11709.m3u8|1709,stream_20769.mp3|769,stream_10769.mp3|769,index_10769.m3u8|769,stream_11218.mp3|1218,index_11218.m3u8|1218,stream_20764.mp3|764,stream_10764.mp3|764,index_10764.m3u8|764,stream_11402.mp3|1402,index_11402.m3u8|1402,stream_22133.mp3|2133,stream_12133.mp3|2133,index_12133.m3u8|2133,stream_21676.mp3|1676,stream_11676.mp3|1676,index_11676.m3u8|1676,stream_11455.mp3|1455,index_11455.m3u8|1455,stream_21456.mp3|1456,stream_11456.mp3|1456,index_11456.m3u8|1456,stream_20768.mp3|768,stream_10768.mp3|768,index_10768.m3u8|768,stream_21613.mp3|1613,stream_11613.mp3|1613,index_11613.m3u8|1613;410000:河南:index_23511.m3u8|3391,index_13510.m3u8|3391,index_23591.m3u8|3405,index_13590.m3u8|3405,index_23603.m3u8|3407,index_13602.m3u8|3407,index_23687.m3u8|3425,index_13686.m3u8|3425,index_23711.m3u8|3434,index_13710.m3u8|3434,index_23761.m3u8|3439,index_13760.m3u8|3439,index_23767.m3u8|3444,index_13766.m3u8|3444,index_23509.m3u8|2120798758550802432,index_13508.m3u8|2120798758550802432,stream_20746.mp3|746,stream_10746.mp3|746,index_10746.m3u8|746,index_23353.m3u8|2320,index_13352.m3u8|2320,stream_21173.mp3|1173,stream_11173.mp3|1173,index_11173.m3u8|1173,index_220392.m3u8|392,index_110392.m3u8|392,index_10392.m3u8|392,index_220393.m3u8|393,index_110393.m3u8|393,index_10393.m3u8|393,stream_21018.mp3|1018,stream_11018.mp3|1018,index_11018.m3u8|1018,stream_20397.mp3|397,stream_10397.mp3|397,index_10397.m3u8|397,stream_21026.mp3|1026,stream_11026.mp3|1026,index_11026.m3u8|1026,index_220391.m3u8|391,index_110391.m3u8|391,index_10391.m3u8|391,stream_21246.mp3|1246,stream_11246.mp3|1246,index_11246.m3u8|1246,stream_21023.mp3|1023,stream_11023.mp3|1023,index_11023.m3u8|1023,stream_21346.mp3|395,stream_11346.mp3|395,index_11346.m3u8|395,stream_21241.mp3|1241,stream_11241.mp3|1241,index_11241.m3u8|1241,stream_20715.mp3|715,stream_10715.mp3|715,index_10715.m3u8|715,stream_11247.mp3|1247,index_11247.m3u8|1247,index_20716.m3u8|716,index_40716.m3u8|716,index_10716.m3u8|716,stream_20717.mp3|717,stream_10717.mp3|717,index_10717.m3u8|717,stream_21021.mp3|1021,stream_11021.mp3|1021,index_11021.m3u8|1021,stream_21243.mp3|1243,stream_11243.mp3|1243,index_11243.m3u8|1243,stream_21520.mp3|1520,stream_11520.mp3|1520,index_11520.m3u8|1520,stream_21163.mp3|1163,stream_11163.mp3|1163,index_11163.m3u8|1163,stream_21161.mp3|1161,stream_11161.mp3|1161,index_11161.m3u8|1161,stream_21779.mp3|1779,stream_11779.mp3|1779,index_11779.m3u8|1779,stream_21838.mp3|1838,stream_11838.mp3|1838,index_11838.m3u8|1838,stream_13279.mp3|3279,stream_23279.mp3|3279,index_23279.m3u8|3279,stream_21982.mp3|1982,stream_11982.mp3|1982,index_11982.m3u8|1982,stream_23271.mp3|3271,stream_13271.mp3|3271,index_13271.m3u8|3271,stream_22422.mp3|2422,stream_12422.mp3|2422,index_12422.m3u8|2422,stream_21777.mp3|1777,stream_11777.mp3|1777,index_11777.m3u8|1777,stream_22551.mp3|2551,stream_12551.mp3|2551,index_12551.m3u8|2551,stream_21704.mp3|1704,stream_11704.mp3|1704,index_11704.m3u8|1704,stream_21249.mp3|1249,stream_11249.mp3|1249,index_11249.m3u8|1249,stream_21705.mp3|1705,stream_11705.mp3|1705,index_11705.m3u8|1705,stream_21164.mp3|1164,stream_11164.mp3|1164,index_11164.m3u8|1164,stream_21909.mp3|1909,stream_11909.mp3|1909,index_11909.m3u8|1909,stream_11408.mp3|1408,index_11408.m3u8|1408,stream_21168.mp3|1168,stream_11168.mp3|1168,index_11168.m3u8|1168,stream_21835.mp3|1835,stream_11835.mp3|1835,index_11835.m3u8|1835,stream_21166.mp3|1166,stream_11166.mp3|1166,index_11166.m3u8|1166,stream_21836.mp3|1836,stream_11836.mp3|1836,index_11836.m3u8|1836,stream_21240.mp3|1240,stream_11240.mp3|1240,index_11240.m3u8|1240,stream_21016.mp3|1016,stream_11016.mp3|1016,index_11016.m3u8|1016,stream_21517.mp3|1517,stream_11517.mp3|1517,index_11517.m3u8|1517,stream_21521.mp3|1521,stream_11521.mp3|1521,index_11521.m3u8|1521,stream_21020.mp3|1020,stream_11020.mp3|1020,index_11020.m3u8|1020,stream_21017.mp3|1017,stream_11017.mp3|1017,index_11017.m3u8|1017,stream_22239.mp3|2239,stream_12239.mp3|2239,index_12239.m3u8|2239,stream_21239.mp3|1239,stream_11239.mp3|1239,index_11239.m3u8|1239,stream_21162.mp3|1162,stream_11162.mp3|1162,index_11162.m3u8|1162,stream_22442.mp3|2442,stream_12442.mp3|2442,index_12442.m3u8|2442,stream_21842.mp3|1842,stream_11842.mp3|1842,index_11842.m3u8|1842,stream_22020.mp3|2020,stream_12020.mp3|2020,index_12020.m3u8|2020,stream_21015.mp3|1015,stream_11015.mp3|1015,index_11015.m3u8|1015,stream_11519.mp3|1519,index_11519.m3u8|1519,stream_21930.mp3|1930,stream_11930.mp3|1930,index_11930.m3u8|1930,stream_21839.mp3|1839,stream_11839.mp3|1839,index_11839.m3u8|1839,stream_21834.mp3|1834,stream_11834.mp3|1834,index_11834.m3u8|1834,stream_21242.mp3|1242,stream_11242.mp3|1242,index_11242.m3u8|1242;230000:黑龙江:index_23563.m3u8|3395,index_13562.m3u8|3395,stream_20755.mp3|755,stream_10755.mp3|755,index_10755.m3u8|755,index_220558.m3u8|558,index_110558.m3u8|558,index_10558.m3u8|558,index_220554.m3u8|554,index_110554.m3u8|554,index_10554.m3u8|554,index_220551.m3u8|551,index_110551.m3u8|551,index_10551.m3u8|551,index_220553.m3u8|553,index_110553.m3u8|553,index_10553.m3u8|553,index_220557.m3u8|557,index_110557.m3u8|557,index_10557.m3u8|557,index_220555.m3u8|555,index_110555.m3u8|555,index_10555.m3u8|555,index_220550.m3u8|550,index_110550.m3u8|550,index_10550.m3u8|550,index_220552.m3u8|552,index_110552.m3u8|552,index_10552.m3u8|552,stream_20841.mp3|841,stream_10841.mp3|841,index_10841.m3u8|841,stream_20842.mp3|842,stream_10842.mp3|842,index_10842.m3u8|842,stream_20840.mp3|840,stream_10840.mp3|840,index_10840.m3u8|840,stream_20836.mp3|836,stream_10836.mp3|836,index_10836.m3u8|836,stream_20835.mp3|835,stream_10835.mp3|835,index_10835.m3u8|835,stream_12466.mp3|2466,stream_22466.mp3|2466,index_22466.m3u8|2466,stream_12465.mp3|2465,stream_22465.mp3|2465,index_22465.m3u8|2465,stream_12467.mp3|2467,stream_22467.mp3|2467,index_22467.m3u8|2467,stream_21963.mp3|1963,stream_11963.mp3|1963,index_11963.m3u8|1963,stream_21964.mp3|1964,stream_11964.mp3|1964,index_11964.m3u8|1964;420000:湖北:index_23433.m3u8|3371,index_13432.m3u8|3371,index_23483.m3u8|3383,index_13482.m3u8|3383,index_23623.m3u8|3410,index_13622.m3u8|3410,index_23625.m3u8|3411,index_13624.m3u8|3411,index_23677.m3u8|3424,index_13676.m3u8|3424,index_23701.m3u8|3430,index_13700.m3u8|3430,index_23739.m3u8|3437,index_13738.m3u8|3437,stream_20753.mp3|753,stream_10753.mp3|753,index_10753.m3u8|753,stream_21696.mp3|1696,stream_11696.mp3|1696,index_11696.m3u8|1696,stream_21804.mp3|1804,stream_11804.mp3|1804,index_11804.m3u8|1804,index_220529.m3u8|529,index_110529.m3u8|529,index_10529.m3u8|529,index_40534.m3u8|534,index_30534.m3u8|534,index_10534.m3u8|534,index_220532.m3u8|532,index_110532.m3u8|532,index_10532.m3u8|532,index_220527.m3u8|527,index_110527.m3u8|527,index_10527.m3u8|527,stream_23308.mp3|3308,stream_13308.mp3|3308,index_13308.m3u8|3308,index_221046.m3u8|1046,index_111046.m3u8|1046,index_11046.m3u8|1046,stream_21040.mp3|1040,stream_11040.mp3|1040,index_11040.m3u8|1040,index_221041.m3u8|1041,index_111041.m3u8|1041,index_11041.m3u8|1041,index_23775.m3u8|1045,index_13774.m3u8|1045,stream_21462.mp3|1462,stream_11462.mp3|1462,index_11462.m3u8|1462,stream_21461.mp3|1461,stream_11461.mp3|1461,index_11461.m3u8|1461,stream_21460.mp3|1460,stream_11460.mp3|1460,index_11460.m3u8|1460,stream_11949.mp3|1949,index_11949.m3u8|1949,stream_11948.mp3|1948,index_11948.m3u8|1948,stream_22184.mp3|2184,stream_12184.mp3|2184,index_12184.m3u8|2184,stream_21983.mp3|1983,stream_11983.mp3|1983,index_11983.m3u8|1983,stream_21030.mp3|1030,stream_11030.mp3|1030,index_11030.m3u8|1030,stream_23344.mp3|3344,stream_13344.mp3|3344,index_13344.m3u8|3344,stream_22006.mp3|2006,stream_12006.mp3|2006,index_12006.m3u8|2006,stream_23270.mp3|3270,stream_13270.mp3|3270,index_13270.m3u8|3270,stream_21556.mp3|1556,stream_11556.mp3|1556,index_11556.m3u8|1556,stream_21447.mp3|1447,stream_11447.mp3|1447,index_11447.m3u8|1447,index_221448.m3u8|1448,index_111448.m3u8|1448,index_11448.m3u8|1448,stream_21530.mp3|1530,stream_11530.mp3|1530,index_11530.m3u8|1530,stream_21529.mp3|1529,stream_11529.mp3|1529,index_11529.m3u8|1529,stream_21031.mp3|1031,stream_11031.mp3|1031,index_11031.m3u8|1031,stream_21034.mp3|1034,stream_11034.mp3|1034,index_11034.m3u8|1034,stream_12008.mp3|2008,index_12008.m3u8|2008,stream_21028.mp3|1028,stream_11028.mp3|1028,index_11028.m3u8|1028,stream_21039.mp3|1039,stream_11039.mp3|1039,index_11039.m3u8|1039,stream_23307.mp3|3307,stream_13307.mp3|3307,index_13307.m3u8|3307,stream_21032.mp3|1032,stream_11032.mp3|1032,index_11032.m3u8|1032,stream_12281.mp3|2281,stream_22281.mp3|2281,index_22281.m3u8|2281,stream_21641.mp3|1641,stream_11641.mp3|1641,index_11641.m3u8|1641,stream_21033.mp3|1033,stream_11033.mp3|1033,index_11033.m3u8|1033;430000:湖南:index_23413.m3u8|3364,index_13412.m3u8|3364,index_23449.m3u8|3372,index_13448.m3u8|3372,index_23651.m3u8|3417,index_13650.m3u8|3417,index_23783.m3u8|3446,index_13782.m3u8|3446,stream_20752.mp3|752,stream_10752.mp3|752,index_10752.m3u8|752,index_220526.m3u8|526,index_110526.m3u8|526,index_10526.m3u8|526,index_221056.m3u8|1056,index_111056.m3u8|1056,index_11056.m3u8|1056,stream_21059.mp3|1059,stream_11059.mp3|1059,index_11059.m3u8|1059,index_220523.m3u8|523,index_110523.m3u8|523,index_10523.m3u8|523,index_220525.m3u8|525,index_110525.m3u8|525,index_10525.m3u8|525,stream_22022.mp3|2022,stream_12022.mp3|2022,index_12022.m3u8|2022,stream_21052.mp3|1052,stream_11052.mp3|1052,index_11052.m3u8|1052,stream_21061.mp3|1061,stream_11061.mp3|1061,index_11061.m3u8|1061,index.m3u8|1051,stream_21531.mp3|1531,stream_11531.mp3|1531,index_11531.m3u8|1531,stream_11872.mp3|1872,index_11872.m3u8|1872,stream_11873.mp3|1873,index_11873.m3u8|1873,stream_21642.mp3|1642,stream_11642.mp3|1642,index_11642.m3u8|1642,stream_22248.mp3|2248,stream_12248.mp3|2248,index_12248.m3u8|2248,stream_21418.mp3|1418,stream_11418.mp3|1418,index_11418.m3u8|1418,stream_21417.mp3|1417,stream_11417.mp3|1417,index_11417.m3u8|1417,stream_21055.mp3|1055,stream_11055.mp3|1055,index_11055.m3u8|1055,stream_22010.mp3|2010,stream_12010.mp3|2010,index_12010.m3u8|2010,stream_21984.mp3|1984,stream_11984.mp3|1984,index_11984.m3u8|1984,stream_21752.mp3|1752,stream_11752.mp3|1752,index_11752.m3u8|1752,stream_21532.mp3|1532,stream_11532.mp3|1532,index_11532.m3u8|1532,stream_21533.mp3|1533,stream_11533.mp3|1533,index_11533.m3u8|1533,stream_21643.mp3|1643,stream_11643.mp3|1643,index_11643.m3u8|1643,stream_21644.mp3|1644,stream_11644.mp3|1644,index_11644.m3u8|1644,stream_11487.mp3|1487,index_11487.m3u8|1487,stream_23298.mp3|3298,stream_13298.mp3|3298,index_13298.m3u8|3298,stream_21050.mp3|1050,stream_11050.mp3|1050,index_11050.m3u8|1050,stream_21048.mp3|1048,stream_11048.mp3|1048,index_11048.m3u8|1048,stream_21053.mp3|1053,stream_11053.mp3|1053,index_11053.m3u8|1053;220000:吉林:index_23491.m3u8|3389,index_13490.m3u8|3389,index_23573.m3u8|3400,index_13572.m3u8|3400,index_23607.m3u8|3408,index_13606.m3u8|3408,index_23679.m3u8|2120801132434649088,index_13678.m3u8|2120801132434649088,stream_20754.mp3|754,stream_10754.mp3|754,index_10754.m3u8|754,index_220545.m3u8|545,index_110545.m3u8|545,index_10545.m3u8|545,stream_20828.mp3|828,stream_10828.mp3|828,index_10828.m3u8|828,index_220546.m3u8|546,index_110546.m3u8|546,index_10546.m3u8|546,stream_11271.mp3|1271,index_11271.m3u8|1271,index_220547.m3u8|547,index_110547.m3u8|547,index_10547.m3u8|547,index_220544.m3u8|544,index_110544.m3u8|544,index_10544.m3u8|544,stream_20829.mp3|829,stream_10829.mp3|829,index_10829.m3u8|829,stream_20830.mp3|830,stream_10830.mp3|830,index_10830.m3u8|830,stream_20832.mp3|832,stream_10832.mp3|832,index_10832.m3u8|832,stream_11274.mp3|1274,index_11274.m3u8|1274,stream_21431.mp3|1431,stream_11431.mp3|1431,index_11431.m3u8|1431,stream_21960.mp3|1960,stream_11960.mp3|1960,index_11960.m3u8|1960,stream_21860.mp3|1860,stream_11860.mp3|1860,index_11860.m3u8|1860,stream_21799.mp3|1799,stream_11799.mp3|1799,index_11799.m3u8|1799,stream_22154.mp3|2154,stream_12154.mp3|2154,index_12154.m3u8|2154,stream_21801.mp3|1801,stream_11801.mp3|1801,index_11801.m3u8|1801,stream_21616.mp3|1616,stream_11616.mp3|1616,index_11616.m3u8|1616,stream_21189.mp3|1189,stream_11189.mp3|1189,index_11189.m3u8|1189,stream_20549.mp3|549,stream_10549.mp3|549,index_10549.m3u8|549,index_220548.m3u8|548,index_110548.m3u8|548,index_10548.m3u8|548;320000:江苏:index_23451.m3u8|3373,index_13450.m3u8|3373,index_23587.m3u8|3404,index_13586.m3u8|3404,index_23629.m3u8|3414,index_13628.m3u8|3414,index_23683.m3u8|3422,index_13682.m3u8|3422,stream_20747.mp3|747,stream_10747.mp3|747,index_10747.m3u8|747,stream_21321.mp3|1321,stream_11321.mp3|1321,index_11321.m3u8|1321,stream_21322.mp3|1322,stream_11322.mp3|1322,index_11322.m3u8|1322,stream_21323.mp3|1323,stream_11323.mp3|1323,index_11323.m3u8|1323,index_220419.m3u8|419,index_110419.m3u8|419,index_10419.m3u8|419,index_220421.m3u8|421,index_110421.m3u8|421,index_10421.m3u8|421,index_220414.m3u8|414,index_110414.m3u8|414,index_10414.m3u8|414,index_220420.m3u8|420,index_110420.m3u8|420,index_10420.m3u8|420,index_220417.m3u8|417,index_110417.m3u8|417,index_10417.m3u8|417,index_220418.m3u8|418,index_110418.m3u8|418,index_10418.m3u8|418,index_220416.m3u8|416,index_110416.m3u8|416,index_10416.m3u8|416,index_220413.m3u8|413,index_110413.m3u8|413,index_10413.m3u8|413,index_220412.m3u8|412,index_110412.m3u8|412,index_10412.m3u8|412,index_220415.m3u8|415,index_110415.m3u8|415,index_10415.m3u8|415,stream_20874.mp3|874,stream_10874.mp3|874,index_10874.m3u8|874,index_220424.m3u8|424,index_110424.m3u8|424,index_10424.m3u8|424,index_220422.m3u8|422,index_110422.m3u8|422,index_10422.m3u8|422,stream_21609.mp3|1609,stream_11609.mp3|1609,index_11609.m3u8|1609,stream_21607.mp3|1607,stream_11607.mp3|1607,index_11607.m3u8|1607,stream_21608.mp3|1608,stream_11608.mp3|1608,index_11608.m3u8|1608,stream_21610.mp3|1610,stream_11610.mp3|1610,index_11610.m3u8|1610,stream_10853.mp3|853,stream_20853.mp3|853,index_20853.m3u8|853,stream_21727.mp3|1727,stream_11727.mp3|1727,index_11727.m3u8|1727,stream_21726.mp3|1726,stream_11726.mp3|1726,index_11726.m3u8|1726,stream_21711.mp3|1711,stream_11711.mp3|1711,index_11711.m3u8|1711,stream_21725.mp3|1725,stream_11725.mp3|1725,index_11725.m3u8|1725,stream_21472.mp3|1472,stream_11472.mp3|1472,index_11472.m3u8|1472,stream_23332.mp3|3332,stream_13332.mp3|3332,index_13332.m3u8|3332,index_40697.m3u8|697,index_30697.m3u8|697,index_10697.m3u8|697,stream_20884.mp3|884,stream_10884.mp3|884,index_10884.m3u8|884,stream_20695.mp3|695,stream_10695.mp3|695,index_10695.m3u8|695,stream_20883.mp3|883,stream_10883.mp3|883,index_10883.m3u8|883,stream_20698.mp3|698,stream_10698.mp3|698,index_10698.m3u8|698,stream_20875.mp3|875,stream_10875.mp3|875,index_10875.m3u8|875,stream_20696.mp3|696,stream_10696.mp3|696,index_10696.m3u8|696,stream_20694.mp3|694,stream_10694.mp3|694,index_10694.m3u8|694,stream_22257.mp3|2257,stream_12257.mp3|2257,index_12257.m3u8|2257,index_220432.m3u8|432,index_110432.m3u8|432,index_10432.m3u8|432,stream_21438.mp3|1438,stream_11438.mp3|1438,index_11438.m3u8|1438,stream_21439.mp3|1439,stream_11439.mp3|1439,index_11439.m3u8|1439,stream_21440.mp3|1440,stream_11440.mp3|1440,index_11440.m3u8|1440,stream_20705.mp3|705,stream_10705.mp3|705,index_10705.m3u8|705,stream_10869.mp3|869,index_10869.m3u8|869,stream_21442.mp3|1442,stream_11442.mp3|1442,index_11442.m3u8|1442,stream_10878.mp3|878,index_10878.m3u8|878,stream_10871.mp3|871,index_10871.m3u8|871,stream_22492.mp3|2492,stream_12492.mp3|2492,index_12492.m3u8|2492,stream_10882.mp3|882,index_10882.m3u8|882,stream_11503.mp3|1503,index_11503.m3u8|1503,stream_20886.mp3|886,stream_10886.mp3|886,index_10886.m3u8|886,stream_20863.mp3|863,stream_10863.mp3|863,index_10863.m3u8|863,stream_20888.mp3|888,stream_10888.mp3|888,index_10888.m3u8|888,stream_20880.mp3|880,stream_10880.mp3|880,index_10880.m3u8|880,stream_20856.mp3|856,stream_10856.mp3|856,index_10856.m3u8|856,stream_20862.mp3|862,stream_10862.mp3|862,index_10862.m3u8|862,stream_22530.mp3|2530,stream_12530.mp3|2530,index_12530.m3u8|2530,stream_22264.mp3|2264,stream_12264.mp3|2264,index_12264.m3u8|2264,stream_20861.mp3|861,stream_10861.mp3|861,index_10861.m3u8|861,stream_20860.mp3|860,stream_10860.mp3|860,index_10860.m3u8|860,stream_20872.mp3|872,stream_10872.mp3|872,index_10872.m3u8|872,stream_22507.mp3|2507,stream_12507.mp3|2507,index_12507.m3u8|2507,stream_23310.mp3|3310,stream_13310.mp3|3310,index_13310.m3u8|3310,stream_23309.mp3|3309,stream_13309.mp3|3309,index_13309.m3u8|3309,playlist.m3u8|1400,index_11400.m3u8|1400,index_10894.m3u8|894;360000:江西:index_23357.m3u8|3352,index_13356.m3u8|3352,index_23635.m3u8|3415,index_13634.m3u8|3415,stream_21422.mp3|1422,stream_11422.mp3|1422,index_11422.m3u8|1422,index_220507.m3u8|507,index_110507.m3u8|507,index_10507.m3u8|507,stream_11235.mp3|1235,index_11235.m3u8|1235,index_220508.m3u8|508,index_110508.m3u8|508,index_10508.m3u8|508,stream_22238.mp3|2238,stream_12238.mp3|2238,index_12238.m3u8|2238,index_220506.m3u8|506,index_110506.m3u8|506,index_10506.m3u8|506,index_220509.m3u8|509,index_110509.m3u8|509,index_10509.m3u8|509,stream_20975.mp3|975,stream_10975.mp3|975,index_10975.m3u8|975,stream_20969.mp3|969,stream_10969.mp3|969,index_10969.m3u8|969,stream_20971.mp3|971,stream_10971.mp3|971,index_10971.m3u8|971,stream_20972.mp3|972,stream_10972.mp3|972,index_10972.m3u8|972,stream_20976.mp3|976,stream_10976.mp3|976,index_10976.m3u8|976,stream_21946.mp3|1946,stream_11946.mp3|1946,index_11946.m3u8|1946,stream_22002.mp3|2002,stream_12002.mp3|2002,index_12002.m3u8|2002,stream_23312.mp3|3312,stream_13312.mp3|3312,index_13312.m3u8|3312,stream_23313.mp3|3313,stream_13313.mp3|3313,index_13313.m3u8|3313,stream_21635.mp3|1635,stream_11635.mp3|1635,index_11635.m3u8|1635,stream_21634.mp3|1634,stream_11634.mp3|1634,index_11634.m3u8|1634,stream_21748.mp3|1748,stream_11748.mp3|1748,index_11748.m3u8|1748,stream_22172.mp3|2172,stream_12172.mp3|2172,index_12172.m3u8|2172;210000:辽宁:index_23419.m3u8|3366,index_13418.m3u8|3366,index_23463.m3u8|3375,index_13462.m3u8|3375,index_23467.m3u8|3376,index_13466.m3u8|3376,index_23773.m3u8|3441,index_13772.m3u8|3441,index_23779.m3u8|3443,index_13778.m3u8|3443,stream_21367.mp3|1367,stream_11367.mp3|1367,index_11367.m3u8|1367,stream_10818.mp3|818,index_10818.m3u8|818,stream_11265.mp3|1265,index_11265.m3u8|1265,stream_11267.mp3|1267,index_11267.m3u8|1267,stream_12233.mp3|2233,index_12233.m3u8|2233,stream_20819.mp3|819,stream_10819.mp3|819,index_10819.m3u8|819,index_220443.m3u8|443,index_110443.m3u8|443,index_10443.m3u8|443,index_220444.m3u8|444,index_110444.m3u8|444,index_10444.m3u8|444,index_220441.m3u8|441,index_110441.m3u8|441,index_10441.m3u8|441,index_220440.m3u8|440,index_110440.m3u8|440,index_10440.m3u8|440,stream_11268.mp3|1268,index_11268.m3u8|1268,stream_20823.mp3|823,stream_10823.mp3|823,index_10823.m3u8|823,stream_20821.mp3|821,stream_10821.mp3|821,index_10821.m3u8|821,stream_20822.mp3|822,stream_10822.mp3|822,index_10822.m3u8|822,stream_21269.mp3|1269,stream_11269.mp3|1269,index_11269.m3u8|1269,stream_20820.mp3|820,stream_10820.mp3|820,index_10820.m3u8|820,stream_22041.mp3|2041,stream_12041.mp3|2041,index_12041.m3u8|2041,stream_20811.mp3|811,stream_10811.mp3|811,index_10811.m3u8|811,stream_20826.mp3|826,stream_10826.mp3|826,index_10826.m3u8|826,stream_23302.mp3|3302,stream_13302.mp3|3302,index_13302.m3u8|3302,stream_21766.mp3|1766,stream_11766.mp3|1766,index_11766.m3u8|1766,stream_22329.mp3|2329,stream_12329.mp3|2329,index_12329.m3u8|2329,stream_21993.mp3|1993,stream_11993.mp3|1993,index_11993.m3u8|1993,stream_22252.mp3|2252,stream_12252.mp3|2252,index_12252.m3u8|2252,stream_22253.mp3|2253,stream_12253.mp3|2253,index_12253.m3u8|2253,stream_22251.mp3|2251,stream_12251.mp3|2251,index_12251.m3u8|2251,stream_22370.mp3|2370,stream_12370.mp3|2370,index_12370.m3u8|2370,stream_22548.mp3|813,stream_12548.mp3|813,index_12548.m3u8|813,stream_22547.mp3|2547,stream_12547.mp3|2547,index_12547.m3u8|2547,stream_20812.mp3|812,stream_10812.mp3|812,index_10812.m3u8|812;150000:内蒙古:index_23391.m3u8|3362,index_13390.m3u8|3362,index_23549.m3u8|3398,index_13548.m3u8|3398,stream_20757.mp3|757,stream_10757.mp3|757,index_10757.m3u8|757,stream_21299.mp3|1299,stream_11299.mp3|1299,index_11299.m3u8|1299,stream_23334.mp3|3334,stream_13334.mp3|3334,index_13334.m3u8|3334,stream_21405.mp3|1405,stream_11405.mp3|1405,index_11405.m3u8|1405,index_220576.m3u8|576,index_110576.m3u8|576,index_10576.m3u8|576,index_220571.m3u8|571,index_110571.m3u8|571,index_10571.m3u8|571,index_220575.m3u8|575,index_110575.m3u8|575,index_10575.m3u8|575,index_220574.m3u8|574,index_110574.m3u8|574,index_10574.m3u8|574,index_220572.m3u8|572,index_110572.m3u8|572,index_10572.m3u8|572,stream_20580.mp3|580,stream_10580.mp3|580,index_10580.m3u8|580,stream_20581.mp3|581,stream_10581.mp3|581,index_10581.m3u8|581,stream_21989.mp3|1989,stream_11989.mp3|1989,index_11989.m3u8|1989,stream_21976.mp3|1976,stream_11976.mp3|1976,index_11976.m3u8|1976,stream_21988.mp3|1988,stream_11988.mp3|1988,index_11988.m3u8|1988,stream_20808.mp3|808,stream_10808.mp3|808,index_10808.m3u8|808,stream_22147.mp3|2147,stream_12147.mp3|2147,index_12147.m3u8|2147,stream_20810.mp3|810,stream_10810.mp3|810,index_10810.m3u8|810,stream_21308.mp3|1308,stream_11308.mp3|1308,index_11308.m3u8|1308,stream_20584.mp3|584,stream_10584.mp3|584,index_10584.m3u8|584,stream_21690.mp3|1690,stream_11690.mp3|1690,index_11690.m3u8|1690,stream_22283.mp3|2283,stream_12283.mp3|2283,index_12283.m3u8|2283,stream_20582.mp3|582,stream_10582.mp3|582,index_10582.m3u8|582,stream_21304.mp3|1304,stream_11304.mp3|1304,index_11304.m3u8|1304,stream_20583.mp3|583,stream_10583.mp3|583,index_10583.m3u8|583,stream_21814.mp3|1814,stream_11814.mp3|1814,index_11814.m3u8|1814,stream_23297.mp3|3297,stream_13297.mp3|3297,index_13297.m3u8|3297,stream_20802.mp3|802,stream_10802.mp3|802,index_10802.m3u8|802,stream_20578.mp3|578,stream_10578.mp3|578,index_10578.m3u8|578,stream_20579.mp3|579,stream_10579.mp3|579,index_10579.m3u8|579;640000:宁夏:stream_20750.mp3|750,stream_10750.mp3|750,index_10750.m3u8|750,stream_21152.mp3|1152,stream_11152.mp3|1152,index_11152.m3u8|1152,index_220469.m3u8|469,index_110469.m3u8|469,index_10469.m3u8|469,stream_21295.mp3|1295,stream_11295.mp3|1295,index_11295.m3u8|1295,stream_11293.mp3|1293,index_11293.m3u8|1293,stream_11151.mp3|1151,index_11151.m3u8|1151,stream_22031.mp3|2031,stream_12031.mp3|2031,index_12031.m3u8|2031,stream_21925.mp3|1925,stream_11925.mp3|1925,index_11925.m3u8|1925;630000:青海:stream_23341.mp3|3341,stream_13341.mp3|3341,index_13341.m3u8|3341,index_220617.m3u8|617,index_110617.m3u8|617,index_10617.m3u8|617,index_220616.m3u8|616,index_110616.m3u8|616,index_10616.m3u8|616,index_220615.m3u8|615,index_110615.m3u8|615,index_10615.m3u8|615,index_220614.m3u8|614,index_110614.m3u8|614,index_10614.m3u8|614,stream_11150.mp3|1150,index_11150.m3u8|1150,stream_11149.mp3|1149,index_11149.m3u8|1149,stream_23296.mp3|3296,stream_13296.mp3|3296,index_13296.m3u8|3296;370000:山东:index_23381.m3u8|3360,index_13380.m3u8|3360,index_23487.m3u8|3377,index_13486.m3u8|3377,index_23525.m3u8|3390,index_13524.m3u8|3390,index_23709.m3u8|3435,index_13708.m3u8|3435,index_23741.m3u8|3438,index_13740.m3u8|3438,index_23755.m3u8|3440,index_13754.m3u8|3440,index_23513.m3u8|2120798760786448384,index_13512.m3u8|2120798760786448384,stream_21365.mp3|1365,stream_11365.mp3|1365,index_11365.m3u8|1365,stream_11637.mp3|1637,index_11637.m3u8|1637,stream_22374.mp3|2374,stream_12374.mp3|2374,index_12374.m3u8|2374,stream_23345.mp3|3345,stream_13345.mp3|3345,index_13345.m3u8|3345,index_40703.m3u8|703,index_30703.m3u8|703,index_10703.m3u8|703,stream_21009.mp3|1009,stream_11009.mp3|1009,index_11009.m3u8|1009,index_220516.m3u8|516,index_110516.m3u8|516,index_10516.m3u8|516,stream_20701.mp3|701,stream_10701.mp3|701,index_10701.m3u8|701,stream_20702.mp3|702,stream_10702.mp3|702,index_10702.m3u8|702,index_20699.m3u8|699,index_10699.m3u8|699,stream_23305.mp3|3305,stream_13305.mp3|3305,index_13305.m3u8|3305,stream_20724.mp3|724,stream_10724.mp3|724,index_10724.m3u8|724,stream_20719.mp3|719,stream_10719.mp3|719,index_10719.m3u8|719,stream_21692.mp3|1692,stream_11692.mp3|1692,index_11692.m3u8|1692,stream_20723.mp3|723,stream_10723.mp3|723,index_10723.m3u8|723,stream_20718.mp3|718,stream_10718.mp3|718,index_10718.m3u8|718,stream_23322.mp3|3322,stream_13322.mp3|3322,index_13322.m3u8|3322,stream_22556.mp3|2556,stream_12556.mp3|2556,index_12556.m3u8|2556,stream_21576.mp3|1576,stream_11576.mp3|1576,index_11576.m3u8|1576,stream_22262.mp3|2262,stream_12262.mp3|2262,index_12262.m3u8|2262,stream_20983.mp3|983,stream_10983.mp3|983,index_10983.m3u8|983,stream_21003.mp3|1003,stream_11003.mp3|1003,index_11003.m3u8|1003,stream_11401.mp3|1401,index_11401.m3u8|1401,stream_21573.mp3|1573,stream_11573.mp3|1573,index_11573.m3u8|1573,stream_20998.mp3|998,stream_10998.mp3|998,index_10998.m3u8|998,stream_21005.mp3|1005,stream_11005.mp3|1005,index_11005.m3u8|1005,stream_20980.mp3|980,stream_10980.mp3|980,index_10980.m3u8|980,stream_20981.mp3|981,stream_10981.mp3|981,index_10981.m3u8|981,stream_22018.mp3|2018,stream_12018.mp3|2018,index_12018.m3u8|2018,stream_21371.mp3|1371,stream_11371.mp3|1371,index_11371.m3u8|1371,stream_22342.mp3|977,stream_12342.mp3|977,index_12342.m3u8|977,stream_22315.mp3|2315,stream_12315.mp3|2315,index_12315.m3u8|2315,stream_21592.mp3|1592,stream_11592.mp3|1592,index_11592.m3u8|1592,stream_20992.mp3|992,stream_10992.mp3|992,index_10992.m3u8|992,stream_21577.mp3|1577,stream_11577.mp3|1577,index_11577.m3u8|1577,stream_20979.mp3|979,stream_10979.mp3|979,index_10979.m3u8|979,stream_21385.mp3|1385,stream_11385.mp3|1385,index_11385.m3u8|1385,stream_21387.mp3|1387,stream_11387.mp3|1387,index_11387.m3u8|1387,stream_21386.mp3|1386,stream_11386.mp3|1386,index_11386.m3u8|1386,stream_21237.mp3|1237,stream_11237.mp3|1237,index_11237.m3u8|1237,stream_21011.mp3|1011,stream_11011.mp3|1011,index_11011.m3u8|1011,stream_21010.mp3|1010,stream_11010.mp3|1010,index_11010.m3u8|1010,stream_23314.mp3|3314,stream_13314.mp3|3314,index_13314.m3u8|3314,stream_23315.mp3|3315,stream_13315.mp3|3315,index_13315.m3u8|3315,stream_23333.mp3|3333,stream_13333.mp3|3333,index_13333.m3u8|3333,stream_21581.mp3|1581,stream_11581.mp3|1581,index_11581.m3u8|1581,stream_20987.mp3|987,stream_10987.mp3|987,index_10987.m3u8|987,stream_21580.mp3|1580,stream_11580.mp3|1580,index_11580.m3u8|1580,stream_21012.mp3|1012,stream_11012.mp3|1012,index_11012.m3u8|1012,stream_21002.mp3|1002,stream_11002.mp3|1002,index_11002.m3u8|1002,stream_21004.mp3|1004,stream_11004.mp3|1004,index_11004.m3u8|1004,stream_21908.mp3|1908,stream_11908.mp3|1908,index_11908.m3u8|1908,stream_22295.mp3|1981,stream_12295.mp3|1981,index_12295.m3u8|1981,stream_21399.mp3|1399,stream_11399.mp3|1399,index_11399.m3u8|1399,stream_20994.mp3|994,stream_10994.mp3|994,index_10994.m3u8|994,stream_20991.mp3|991,stream_10991.mp3|991,index_10991.m3u8|991,stream_21750.mp3|1750,stream_11750.mp3|1750,index_11750.m3u8|1750,stream_11774.mp3|1774,stream_21774.mp3|1774,index_21774.m3u8|1774,stream_21979.mp3|1979,stream_11979.mp3|1979,index_11979.m3u8|1979,stream_20995.mp3|995,stream_10995.mp3|995,index_10995.m3u8|995,stream_22017.mp3|2017,stream_12017.mp3|2017,index_12017.m3u8|2017,stream_22179.mp3|2179,stream_12179.mp3|2179,index_12179.m3u8|2179,stream_21583.mp3|1583,stream_11583.mp3|1583,index_11583.m3u8|1583,stream_21378.mp3|1378,stream_11378.mp3|1378,index_11378.m3u8|1378,stream_21377.mp3|1377,stream_11377.mp3|1377,index_11377.m3u8|1377,stream_21376.mp3|1376,stream_11376.mp3|1376,index_11376.m3u8|1376,stream_21582.mp3|1582,stream_11582.mp3|1582,index_11582.m3u8|1582,stream_20986.mp3|986,stream_10986.mp3|986,index_10986.m3u8|986,stream_21001.mp3|1001,stream_11001.mp3|1001,index_11001.m3u8|1001,stream_20999.mp3|999,stream_10999.mp3|999,index_10999.m3u8|999,stream_21395.mp3|1395,stream_11395.mp3|1395,index_11395.m3u8|1395,stream_21396.mp3|1396,stream_11396.mp3|1396,index_11396.m3u8|1396,stream_21394.mp3|1394,stream_11394.mp3|1394,index_11394.m3u8|1394,stream_22524.mp3|2524,stream_12524.mp3|2524,index_12524.m3u8|2524;140000:山西:index_23355.m3u8|3351,index_13354.m3u8|3351,index_23655.m3u8|3426,index_13654.m3u8|3426,stream_21362.mp3|1362,stream_11362.mp3|1362,index_11362.m3u8|1362,index_220638.m3u8|638,index_110638.m3u8|638,index_10638.m3u8|638,index_220634.m3u8|634,index_110634.m3u8|634,index_10634.m3u8|634,stream_20796.mp3|796,stream_10796.mp3|796,index_10796.m3u8|796,index_40633.m3u8|633,index_30633.m3u8|633,index_10633.m3u8|633,index_220635.m3u8|635,index_110635.m3u8|635,index_10635.m3u8|635,index_220636.m3u8|636,index_110636.m3u8|636,index_10636.m3u8|636,index_220637.m3u8|637,index_110637.m3u8|637,index_10637.m3u8|637,stream_22230.mp3|2230,stream_12230.mp3|2230,index_12230.m3u8|2230,stream_21409.mp3|1409,stream_11409.mp3|1409,index_11409.m3u8|1409,stream_10797.mp3|797,index_10797.m3u8|797,stream_21227.mp3|1227,stream_11227.mp3|1227,index_11227.m3u8|1227,stream_21228.mp3|1228,stream_11228.mp3|1228,index_11228.m3u8|1228,stream_20787.mp3|787,stream_10787.mp3|787,index_10787.m3u8|787,stream_21471.mp3|1471,stream_11471.mp3|1471,index_11471.m3u8|1471,index_21410.m3u8|1410,index_11410.m3u8|1410,stream_22138.mp3|2138,stream_12138.mp3|2138,index_12138.m3u8|2138,stream_20798.mp3|798,stream_10798.mp3|798,index_10798.m3u8|798,stream_20792.mp3|792,stream_10792.mp3|792,index_10792.m3u8|792,stream_21958.mp3|1958,stream_11958.mp3|1958,index_11958.m3u8|1958,stream_21959.mp3|1959,stream_11959.mp3|1959,index_11959.m3u8|1959,stream_21957.mp3|1957,stream_11957.mp3|1957,index_11957.m3u8|1957,stream_21939.mp3|1939,stream_11939.mp3|1939,index_11939.m3u8|1939,stream_12139.mp3|2139,index_12139.m3u8|2139,stream_21938.mp3|1938,stream_11938.mp3|1938,index_11938.m3u8|1938,stream_20799.mp3|799,stream_10799.mp3|799,index_10799.m3u8|799,stream_22140.mp3|2140,stream_12140.mp3|2140,index_12140.m3u8|2140,stream_20794.mp3|794,stream_10794.mp3|794,index_10794.m3u8|794,stream_21404.mp3|1404,stream_11404.mp3|1404,index_11404.m3u8|1404,stream_21403.mp3|1403,stream_11403.mp3|1403,index_11403.m3u8|1403,stream_21614.mp3|1614,stream_11614.mp3|1614,index_11614.m3u8|1614;610000:陕西:index_23348.m3u8|3349,index_13348.m3u8|3349,stream_20756.mp3|756,stream_10756.mp3|756,index_10756.m3u8|756,stream_20560.mp3|560,stream_10560.mp3|560,index_10560.m3u8|560,stream_20563.mp3|563,stream_10563.mp3|563,index_10563.m3u8|563,index_220564.m3u8|564,index_110564.m3u8|564,index_10564.m3u8|564,index_220565.m3u8|565,index_110565.m3u8|565,index_10565.m3u8|565,index_220559.m3u8|559,index_110559.m3u8|559,index_10559.m3u8|559,index_220561.m3u8|561,index_110561.m3u8|561,index_10561.m3u8|561,stream_11289.mp3|1289,index_11289.m3u8|1289,stream_11134.mp3|1134,index_11134.m3u8|1134,stream_11135.mp3|1135,index_11135.m3u8|1135,stream_21806.mp3|1806,stream_11806.mp3|1806,index_11806.m3u8|1806,stream_21805.mp3|1805,stream_11805.mp3|1805,index_11805.m3u8|1805,stream_21682.mp3|1682,stream_11682.mp3|1682,index_11682.m3u8|1682,stream_21679.mp3|1679,stream_11679.mp3|1679,index_11679.m3u8|1679,stream_21920.mp3|1919,stream_11920.mp3|1919,index_11920.m3u8|1919,stream_21921.mp3|1920,stream_11921.mp3|1920,index_11921.m3u8|1920,stream_21468.mp3|1468,stream_11468.mp3|1468,index_11468.m3u8|1468,stream_20713.mp3|713,stream_10713.mp3|713,index_10713.m3u8|713,stream_20712.mp3|712,stream_10712.mp3|712,index_10712.m3u8|712,stream_20568.mp3|568,stream_10568.mp3|568,index_10568.m3u8|568,stream_20569.mp3|569,stream_10569.mp3|569,index_10569.m3u8|569,stream_20567.mp3|567,stream_10567.mp3|567,index_10567.m3u8|567;310000:上海:index_220744.m3u8|744,index_110744.m3u8|744,index_10744.m3u8|744,stream_20843.mp3|843,stream_10843.mp3|843,index_10843.m3u8|843,index_220370.m3u8|370,index_110370.m3u8|370,index_10370.m3u8|370,stream_21316.mp3|1316,stream_11316.mp3|1316,index_11316.m3u8|1316,stream_21313.mp3|1313,stream_11313.mp3|1313,index_11313.m3u8|1313,stream_21312.mp3|1312,stream_11312.mp3|1312,index_11312.m3u8|1312,stream_20849.mp3|849,stream_10849.mp3|849,index_10849.m3u8|849;510000:四川:index_23351.m3u8|3354,index_13350.m3u8|3354,index_23475.m3u8|3385,index_13474.m3u8|3385,index_23671.m3u8|3420,index_13670.m3u8|3420,index_23657.m3u8|3421,index_13656.m3u8|3421,index_23707.m3u8|3431,index_13706.m3u8|3431,index_23785.m3u8|3445,index_13784.m3u8|3445,stream_20749.mp3|749,stream_10749.mp3|749,index_10749.m3u8|749,stream_12217.mp3|2217,index_12217.m3u8|2217,index_220450.m3u8|450,index_110450.m3u8|450,index_10450.m3u8|450,index_220449.m3u8|449,index_110449.m3u8|449,index_10449.m3u8|449,index_220447.m3u8|447,index_110447.m3u8|447,index_10447.m3u8|447,index_220451.m3u8|451,index_110451.m3u8|451,index_10451.m3u8|451,stream_21448.mp3|448,stream_11448.mp3|448,index_11448.m3u8|448,index_220452.m3u8|452,index_110452.m3u8|452,index_10452.m3u8|452,stream_21851.mp3|1851,stream_11851.mp3|1851,index_11851.m3u8|1851,stream_22400.mp3|2400,stream_12400.mp3|2400,index_12400.m3u8|2400,stream_20457.mp3|457,stream_10457.mp3|457,index_10457.m3u8|457,stream_11360.mp3|1360,index_11360.m3u8|1360,stream_22401.mp3|2401,stream_12401.mp3|2401,index_12401.m3u8|2401,stream_21600.mp3|1600,stream_11600.mp3|1600,index_11600.m3u8|1600,stream_12255.mp3|2255,index_12255.m3u8|2255,stream_21545.mp3|1545,stream_11545.mp3|1545,index_11545.m3u8|1545,stream_21546.mp3|1546,stream_11546.mp3|1546,index_11546.m3u8|1546,stream_23317.mp3|3317,stream_13317.mp3|3317,index_13317.m3u8|3317,stream_22024.mp3|2024,stream_12024.mp3|2024,index_12024.m3u8|2024,stream_12321.mp3|2321,index_12321.m3u8|2321,stream_22249.mp3|2249,stream_12249.mp3|2249,index_12249.m3u8|2249,stream_21782.mp3|1782,stream_11782.mp3|1782,index_11782.m3u8|1782,stream_21783.mp3|1783,stream_11783.mp3|1783,index_11783.m3u8|1783,stream_21112.mp3|1112,stream_11112.mp3|1112,index_11112.m3u8|1112,stream_21111.mp3|1111,stream_11111.mp3|1111,index_11111.m3u8|1111,stream_21113.mp3|1113,stream_11113.mp3|1113,index_11113.m3u8|1113,stream_11549.mp3|1549,index_11549.m3u8|1549,stream_11550.mp3|1550,index_11550.m3u8|1550,stream_12306.mp3|2306,stream_22306.mp3|2306,index_22306.m3u8|2306,stream_12305.mp3|2305,stream_22305.mp3|2305,index_22305.m3u8|2305,stream_20742.mp3|742,stream_10742.mp3|742,index_10742.m3u8|742,stream_21557.mp3|1557,stream_11557.mp3|1557,index_11557.m3u8|1557,stream_21655.mp3|1655,stream_11655.mp3|1655,index_11655.m3u8|1655,stream_21105.mp3|1105,stream_11105.mp3|1105,index_11105.m3u8|1105,stream_21498.mp3|1498,stream_11498.mp3|1498,index_11498.m3u8|1498,stream_21499.mp3|1499,stream_11499.mp3|1499,index_11499.m3u8|1499,stream_21759.mp3|1759,stream_11759.mp3|1759,index_11759.m3u8|1759,stream_21392.mp3|1392,stream_11392.mp3|1392,index_11392.m3u8|1392,stream_12404.mp3|2404,index_12404.m3u8|2404,stream_22209.mp3|2209,stream_12209.mp3|2209,index_12209.m3u8|2209,stream_22297.mp3|2297,stream_12297.mp3|2297,index_12297.m3u8|2297,stream_21719.mp3|1719,stream_11719.mp3|1719,index_11719.m3u8|1719,stream_21101.mp3|1101,stream_11101.mp3|1101,index_11101.m3u8|1101;540000:西藏:1|3299,stream_23342.mp3|3342,stream_13342.mp3|3342,index_13342.m3u8|3342,index_220628.m3u8|628,index_110628.m3u8|628,index_10628.m3u8|628,stream_20630.mp3|2241,stream_10630.mp3|2241,index_10630.m3u8|2241,index_220627.m3u8|627,index_110627.m3u8|627,index_10627.m3u8|627;650000:新疆:index_23455.m3u8|3374,index_13454.m3u8|3374,index_23575.m3u8|3401,index_13574.m3u8|3401,index_23713.m3u8|3432,index_13712.m3u8|3432,stream_20758.mp3|758,stream_10758.mp3|758,index_10758.m3u8|758,stream_23336.mp3|3336,stream_13336.mp3|3336,index_13336.m3u8|3336,index_220620.m3u8|620,index_110620.m3u8|620,index_10620.m3u8|620,stream_20623.mp3|623,stream_10623.mp3|623,index_10623.m3u8|623,index_220626.m3u8|626,index_110626.m3u8|626,index_10626.m3u8|626,index_220618.m3u8|618,index_110618.m3u8|618,index_10618.m3u8|618,index_220621.m3u8|621,index_110621.m3u8|621,index_10621.m3u8|621,index_220622.m3u8|622,index_110622.m3u8|622,index_10622.m3u8|622,index_220625.m3u8|625,index_110625.m3u8|625,index_10625.m3u8|625,index_220619.m3u8|619,index_110619.m3u8|619,index_10619.m3u8|619,index_220624.m3u8|624,index_110624.m3u8|624,index_10624.m3u8|624,stream_21158.mp3|1158,stream_11158.mp3|1158,index_11158.m3u8|1158,stream_22298.mp3|2298,stream_12298.mp3|2298,index_12298.m3u8|2298,stream_22300.mp3|2300,stream_12300.mp3|2300,index_12300.m3u8|2300,stream_22301.mp3|2301,stream_12301.mp3|2301,index_12301.m3u8|2301,stream_22299.mp3|2299,stream_12299.mp3|2299,index_12299.m3u8|2299,stream_21761.mp3|1761,stream_11761.mp3|1761,index_11761.m3u8|1761,stream_22475.mp3|2475,stream_12475.mp3|2475,index_12475.m3u8|2475,stream_22474.mp3|2474,stream_12474.mp3|2474,index_12474.m3u8|2474,stream_21819.mp3|1819,stream_11819.mp3|1819,index_11819.m3u8|1819,stream_23300.mp3|3300,stream_13300.mp3|3300,index_13300.m3u8|3300,stream_23301.mp3|3301,stream_13301.mp3|3301,index_13301.m3u8|3301,stream_11953.mp3|1953,index_11953.m3u8|1953,stream_22554.mp3|2554,stream_12554.mp3|2554,index_12554.m3u8|2554,stream_22038.mp3|2038,stream_12038.mp3|2038,index_12038.m3u8|2038,stream_22037.mp3|2037,stream_12037.mp3|2037,index_12037.m3u8|2037,stream_22406.mp3|2406,stream_12406.mp3|2406,index_12406.m3u8|2406,stream_22407.mp3|2407,stream_12407.mp3|2407,index_12407.m3u8|2407,stream_22036.mp3|2036,stream_12036.mp3|2036,index_12036.m3u8|2036,stream_23319.mp3|3319,stream_13319.mp3|3319,index_13319.m3u8|3319,stream_23320.mp3|3320,stream_13320.mp3|3320,index_13320.m3u8|3320,stream_23324.mp3|3324,stream_13324.mp3|3324,index_13324.m3u8|3324,stream_23328.mp3|3328,stream_13328.mp3|3328,index_13328.m3u8|3328,stream_23325.mp3|3325,stream_13325.mp3|3325,index_13325.m3u8|3325,stream_23327.mp3|3327,stream_13327.mp3|3327,index_13327.m3u8|3327,stream_23330.mp3|3330,stream_13330.mp3|3330,index_13330.m3u8|3330,stream_23326.mp3|3326,stream_13326.mp3|3326,index_13326.m3u8|3326,stream_23331.mp3|3331,stream_13331.mp3|3331,index_13331.m3u8|3331,stream_23329.mp3|3329,stream_13329.mp3|3329,index_13329.m3u8|3329,stream_22408.mp3|2408,stream_12408.mp3|2408,index_12408.m3u8|2408,stream_22033.mp3|2033,stream_12033.mp3|2033,index_12033.m3u8|2033,stream_22032.mp3|2032,stream_12032.mp3|2032,index_12032.m3u8|2032,stream_22224.mp3|2224,stream_12224.mp3|2224,index_12224.m3u8|2224,stream_21883.mp3|1883,stream_11883.mp3|1883,index_11883.m3u8|1883,stream_11885.mp3|1885,index_11885.m3u8|1885,stream_11880.mp3|1880,index_11880.m3u8|1880,stream_11954.mp3|1954,index_11954.m3u8|1954,stream_11884.mp3|1884,index_11884.m3u8|1884;660000:新疆兵团:index_220738.m3u8|738,index_110738.m3u8|738,index_10738.m3u8|738,stream_21887.mp3|1887,stream_11887.mp3|1887,index_11887.m3u8|1887;530000:云南:index_23545.m3u8|3379,index_13544.m3u8|3379,index_23585.m3u8|3403,index_13584.m3u8|3403,index_220597.m3u8|597,index_110597.m3u8|597,index_10597.m3u8|597,stream_20594.mp3|594,stream_10594.mp3|594,index_10594.m3u8|594,index_220596.m3u8|596,index_110596.m3u8|596,index_10596.m3u8|596,index_220591.m3u8|591,index_110591.m3u8|591,index_10591.m3u8|591,index_220592.m3u8|592,index_110592.m3u8|592,index_10592.m3u8|592,stream_22343.mp3|2343,stream_12343.mp3|2343,index_12343.m3u8|2343,stream_22312.mp3|2312,stream_12312.mp3|2312,index_12312.m3u8|2312,stream_22309.mp3|2309,stream_12309.mp3|2309,index_12309.m3u8|2309,stream_22026.mp3|2026,stream_12026.mp3|2026,index_12026.m3u8|2026,stream_21169.mp3|1169,stream_11169.mp3|1169,index_11169.m3u8|1169,stream_22028.mp3|2028,stream_12028.mp3|2028,index_12028.m3u8|2028,stream_21486.mp3|1486,stream_11486.mp3|1486,index_11486.m3u8|1486,stream_21662.mp3|1662,stream_11662.mp3|1662,index_11662.m3u8|1662,stream_21129.mp3|1129,stream_11129.mp3|1129,index_11129.m3u8|1129,stream_22316.mp3|2316,stream_12316.mp3|2316,index_12316.m3u8|2316,stream_21398.mp3|1398,stream_11398.mp3|1398,index_11398.m3u8|1398,stream_21877.mp3|1877,stream_11877.mp3|1877,index_11877.m3u8|1877,stream_21878.mp3|2274,stream_11878.mp3|2274,index_11878.m3u8|2274,stream_21122.mp3|1122,stream_11122.mp3|1122,index_11122.m3u8|1122,stream_22308.mp3|2308,stream_12308.mp3|2308,index_12308.m3u8|2308,stream_21667.mp3|1667,stream_11667.mp3|1667,index_11667.m3u8|1667,stream_21683.mp3|1683,stream_11683.mp3|1683,index_11683.m3u8|1683,stream_21670.mp3|1670,stream_11670.mp3|1670,index_11670.m3u8|1670,stream_22222.mp3|2222,stream_12222.mp3|2222,index_12222.m3u8|2222,stream_21669.mp3|1669,stream_11669.mp3|1669,index_11669.m3u8|1669,stream_22394.mp3|2394,stream_12394.mp3|2394,index_12394.m3u8|2394,stream_22029.mp3|2029,stream_12029.mp3|2029,index_12029.m3u8|2029,stream_21211.mp3|1211,stream_11211.mp3|1211,index_11211.m3u8|1211;330000:浙江:index_23515.m3u8|3378,index_13514.m3u8|3378,index_23477.m3u8|3380,index_13476.m3u8|3380,index_23613.m3u8|3412,index_13612.m3u8|3412,index_23639.m3u8|3419,index_13638.m3u8|3419,index_23715.m3u8|3433,index_13714.m3u8|3433,stream_21363.mp3|1363,stream_11363.mp3|1363,index_11363.m3u8|1363,stream_11444.mp3|1444,index_11444.m3u8|1444,stream_11569.mp3|1569,index_11569.m3u8|1569,stream_11626.mp3|1626,index_11626.m3u8|1626,stream_12269.mp3|2269,index_12269.m3u8|2269,index_220463.m3u8|463,index_110463.m3u8|463,index_10463.m3u8|463,index_220460.m3u8|460,index_110460.m3u8|460,index_10460.m3u8|460,index_220461.m3u8|461,index_110461.m3u8|461,index_10461.m3u8|461,index_220465.m3u8|465,index_110465.m3u8|465,index_10465.m3u8|465,index_220462.m3u8|462,index_110462.m3u8|462,index_10462.m3u8|462,stream_10928.mp3|928,index_10928.m3u8|928,index_220459.m3u8|459,index_110459.m3u8|459,index_10459.m3u8|459,stream_21232.mp3|1232,stream_11232.mp3|1232,index_11232.m3u8|1232,stream_20924.mp3|924,stream_10924.mp3|924,index_10924.m3u8|924,stream_22545.mp3|2545,stream_12545.mp3|2545,index_12545.m3u8|2545,stream_20933.mp3|933,stream_10933.mp3|933,index_10933.m3u8|933,stream_21714.mp3|1714,stream_11714.mp3|1714,index_11714.m3u8|1714,stream_21234.mp3|1234,stream_11234.mp3|1234,index_11234.m3u8|1234,stream_23306.mp3|3306,stream_13306.mp3|3306,index_13306.m3u8|3306,stream_10931.mp3|931,index_10931.m3u8|931,stream_10918.mp3|918,index_10918.m3u8|918,stream_10930.mp3|930,index_10930.m3u8|930,stream_20923.mp3|923,stream_10923.mp3|923,index_10923.m3u8|923,stream_20711.mp3|711,stream_10711.mp3|711,index_10711.m3u8|711,stream_20709.mp3|709,stream_10709.mp3|709,index_10709.m3u8|709,stream_22073.mp3|2073,stream_12073.mp3|2073,index_12073.m3u8|2073,stream_11629.mp3|1629,index_11629.m3u8|1629,stream_20925.mp3|929,stream_10925.mp3|929,index_10925.m3u8|929,stream_20911.mp3|911,stream_10911.mp3|911,index_10911.m3u8|911,stream_20929.mp3|925,stream_10929.mp3|925,index_10929.m3u8|925,stream_21715.mp3|1715,stream_11715.mp3|1715,index_11715.m3u8|1715,stream_21628.mp3|1628,stream_11628.mp3|1628,index_11628.m3u8|1628,stream_21630.mp3|1630,stream_11630.mp3|1630,index_11630.m3u8|1630,stream_20907.mp3|907,stream_10907.mp3|907,index_10907.m3u8|907,stream_20913.mp3|913,stream_10913.mp3|913,index_10913.m3u8|913,stream_20898.mp3|898,stream_10898.mp3|898,index_10898.m3u8|898,stream_22247.mp3|2247,stream_12247.mp3|2247,index_12247.m3u8|2247,stream_22246.mp3|2246,stream_12246.mp3|2246,index_12246.m3u8|2246,stream_11325.mp3|1325,index_11325.m3u8|1325,stream_21324.mp3|1324,stream_11324.mp3|1324,index_11324.m3u8|1324,stream_20903.mp3|903,stream_10903.mp3|903,index_10903.m3u8|903,stream_20895.mp3|895,stream_10895.mp3|895,index_10895.m3u8|895,stream_20899.mp3|899,stream_10899.mp3|899,index_10899.m3u8|899,stream_20932.mp3|932,stream_10932.mp3|932,index_10932.m3u8|932,stream_20912.mp3|912,stream_10912.mp3|912,index_10912.m3u8|912,stream_21568.mp3|1568,stream_11568.mp3|1568,index_11568.m3u8|1568,stream_22072.mp3|2072,stream_12072.mp3|2072,index_12072.m3u8|2072,stream_23293.mp3|3293,stream_13293.mp3|3293,index_13293.m3u8|3293,stream_20901.mp3|901,stream_10901.mp3|901,index_10901.m3u8|901,stream_20910.mp3|910,stream_10910.mp3|910,index_10910.m3u8|910,stream_20906.mp3|906,stream_10906.mp3|906,index_10906.m3u8|906,stream_21965.mp3|1965,stream_11965.mp3|1965,index_11965.m3u8|1965,stream_20896.mp3|896,stream_10896.mp3|896,index_10896.m3u8|896,stream_20909.mp3|909,stream_10909.mp3|909,index_10909.m3u8|909,stream_20920.mp3|920,stream_10920.mp3|920,index_10920.m3u8|920,stream_20919.mp3|919,stream_10919.mp3|919,index_10919.m3u8|919,stream_20916.mp3|916,stream_10916.mp3|916,index_10916.m3u8|916,stream_20922.mp3|922,stream_10922.mp3|922,index_10922.m3u8|922,stream_20905.mp3|905,stream_10905.mp3|905,index_10905.m3u8|905";
// <<< 静态目录 <<<

const snapshotAgeDays = () => {
  const t = Date.parse(STATIC_CATALOG_AT);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

function loadStaticCatalog() {
  if (!STATIC_CATALOG || STATIC_CATALOG.length < 100) return;
  for (const block of STATIC_CATALOG.split(";")) {
    if (!block) continue;
    const i = block.indexOf(":");
    const j = block.indexOf(":", i + 1);
    if (i < 0 || j < 0) continue;
    const code = block.slice(0, i);
    const name = block.slice(i + 1, j);
    store.provinces.push([code, name]);
    store.done.add(code);
    for (const ent of block.slice(j + 1).split(",")) {
      if (!ent) continue;
      const k = ent.lastIndexOf("|");
      if (k <= 0) continue;
      store.index.set(ent.slice(0, k), [code, ent.slice(k + 1)]);
    }
  }
}
loadStaticCatalog();

async function apiGet(env, path, params = "", retries = 2) {
  const c = cfg(env);
  if (!c.key) throw new Error("未配置 SIGN_KEY");
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ts = String(Date.now());
    const url = c.api + path + (params ? "?" + params : "");
    try {
      const r = await fetchT(url, {
        headers: {
          sign: makeSign(params, ts, c.key),
          timestamp: ts,
          platformCode: "WEB",
          equipmentId: "0000",
          "Content-Type": "application/json",
          "User-Agent": c.ua,
          Accept: "application/json",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      }, 8000);
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("接口返回非 JSON（HTTP " + r.status + "）");
      }
      if (data.code !== 0 && data.code != null) {
        throw new Error("api code=" + data.code + " message=" + data.message);
      }
      return data;
    } catch (e) {
      last = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error("api " + path + " failed: " + (last && last.message ? last.message : last));
}

// force=true 时强制从接口重取：静态快照里的省表本身也可能过期
async function loadProvinces(env, force = false) {
  if (!force && store.provinces.length) return store.provinces;
  const data = await apiGet(env, "/web/appProvince/list/all");
  const provs = [];
  for (const p of data.data || []) {
    const code = String(p.provinceCode);
    if (code === "None" || code === "null") continue;
    provs.push([code, p.provinceName || code]);
  }
  store.provinces = provs;
  return provs;
}

async function refreshProvince(env, code, ctx) {
  const data = await apiGet(env, "/web/appBroadcast/list", "categoryId=0&provinceCode=" + code);
  const rows = data.data || [];
  const entry = { at: Date.now(), rows };
  store.items.set(code, entry);
  writeProvinceCache(code, entry, ctx);   // 不 await，写缓存失败不影响本次请求
  for (const st of rows) {
    const cid = String(st.contentId);
    for (const f of PREFER_FIELDS) {
      const b = basename(st[f] || "");
      if (b && !store.index.has(b)) store.index.set(b, [code, cid]);
    }
  }
}

// ---- 省数据放进边缘缓存 ----
// 模块内存是「每个 isolate 一份」，低流量下 Cloudflare 会不停换实例，换一次就得重拉一次省列表。
// 写进 caches.default 后，同一个机房的所有实例共享，冷启动概率大幅下降。
// 注意：Cache API 只认与请求同 hostname 的键，所以键用 store.origin 拼。
const provKey = (code) => (store.origin || "https://radio-cn-sign.invalid") + "/__prov/" + code;

async function readProvinceCache(code) {
  if (typeof caches === "undefined" || !store.origin) return null;
  try {
    const hit = await caches.default.match(provKey(code));
    if (!hit) return null;
    const j = await hit.json();
    if (!j || !Array.isArray(j.rows) || !j.rows.length) return null;
    return j;
  } catch {
    return null;
  }
}

function writeProvinceCache(code, entry, ctx) {
  if (typeof caches === "undefined" || !store.origin) return;
  const p = caches.default.put(provKey(code), new Response(
    JSON.stringify({ at: entry.at, rows: entry.rows }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1800" } }
  )).catch(() => { /* 写不进去就算了 */ });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

// 运行时兜底：静态目录里没有的 basename（新上线/换号的台）才走这里，
// 把各省列表重新抓一遍补进索引。正常播放路径一次都不会跑。
// 并发 6：Cloudflare 单次调用最多 6 条并发出站连接，再多也只是排队。
async function buildIndex(env, force = false) {
  if (force) store.done.clear();
  const provs = await loadProvinces(env, force);
  if (force) store.provinces = provs;
  const queue = provs.map((p) => p[0]).filter((c) => !store.done.has(c));
  if (!queue.length) return;

  let errors = 0;
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        await refreshProvince(env, code);
        store.done.add(code);
      } catch (e) {
        errors++;
        if (cfg(env).debug) log("province " + code + " failed: " + e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  log("目录重建: " + store.done.size + "/" + provs.length + " 个地区, "
      + store.index.size + " 个索引, 失败 " + errors);
}

const isComplete = () =>
  store.provinces.length > 0 && store.done.size >= store.provinces.length;

// 静态目录在模块初始化时已经填好，正常路径到这里直接返回 true
async function ensureIndex(env) {
  if (store.index.size) return true;
  if (store.building) {
    try { await store.building; } catch { /* 下面统一看结果 */ }
    return store.index.size > 0;
  }
  store.building = buildIndex(env, true).catch((e) => {
    store.lastError = (e && e.message) || String(e);
    log("buildIndex failed: " + store.lastError);
  }).finally(() => { store.building = null; });
  await store.building;
  return store.index.size > 0;
}

// 索引里查不到时重建一次。5 分钟冷却，避免一个失效地址把子请求额度打光。
// staleName：已知失效的那条映射，重建前先删掉。
// 因为 refreshProvince 里是 `if (!index.has(b))` 才写入，不删的话旧映射永远盖不掉。
async function refreshIndexOnce(env, staleName) {
  if (Date.now() - store.rebuiltAt < 300000) return false;
  store.rebuiltAt = Date.now();
  if (staleName) store.index.delete(staleName);
  try {
    await buildIndex(env, true);
    return true;
  } catch (e) {
    store.lastError = (e && e.message) || String(e);
    return false;
  }
}

function lookupIndex(name) {
  return store.index.get(name) || null;
}

// 拿某地区下某频道的记录；超过 RESIGN_WINDOW 就重抓该地区（即重新签一个新令牌）
// 后台续签：缓存过期不阻塞请求，先把旧令牌发出去（它能活 45 分钟），
// 同时让 waitUntil 去换新的。否则每 RESIGN_WINDOW 秒就有一次 2~3 秒的卡顿。
const refreshing = new Set();
function refreshProvinceAsync(env, code, ctx) {
  if (refreshing.has(code)) return;
  refreshing.add(code);
  const p = refreshProvince(env, code, ctx)
    .catch(() => { /* 后台失败就继续用旧令牌 */ })
    .finally(() => refreshing.delete(code));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

async function getStationRow(env, code, cid, ctx) {
  let entry = store.items.get(code);
  if (!entry) {
    // 内存里没有，先问同机房的边缘缓存（别的实例可能已经拉过了）
    const cached = await readProvinceCache(code);
    if (cached) {
      entry = { at: cached.at, rows: cached.rows };
      store.items.set(code, entry);
    }
  }
  if (!entry) {
    await refreshProvince(env, code, ctx);     // 真的一次都没有，只能等
  } else if (Date.now() - entry.at > cfg(env).resignWindow) {
    refreshProvinceAsync(env, code, ctx);      // 有旧的，先发旧的，后台换新
  }
  let cur = store.items.get(code);
  if (!cur) return null;
  for (const st of cur.rows) {
    if (String(st.contentId) === String(cid)) return st;
  }
  // 查不到就把决定权交回 resolveSignedUrl：由它删掉这条失效映射、重建、再试一次。
  // 这里不要自己调 refreshIndexOnce —— 它会把 5 分钟冷却吃掉，导致真正的恢复被挡住。
  return null;
}

function pickSignedUrl(station, wantName) {
  for (const f of PREFER_FIELDS) {
    const u = station[f] || "";
    if (u && basename(u) === wantName) return u;
  }
  for (const f of PREFER_FIELDS) {
    const u = station[f] || "";
    if (u) return u;
  }
  return "";
}

// 输入用户给的（可能已过期的）地址，返回新的带签地址；非 radio.cn 直接透传
async function resolveSignedUrl(env, target, ctx) {
  let t = String(target || "").trim();
  if (!/^https?:\/\//i.test(t)) {
    if (/^\d+$/.test(t)) t = "http://ytcast2.radio.cn/index_" + t + ".m3u8";
    else if (t.startsWith("index_")) t = "http://ytcast2.radio.cn/" + t;
    else throw new HttpError(400, "url 参数不是合法地址");
  }
  if (!looksLikeRadioCn(t)) return [t, null];

  const name = basename(t);
  if (!name) throw new HttpError(400, "无法从地址中解析出频道索引文件");

  if (!(await ensureIndex(env))) {
    throw new HttpError(502, "频道目录构建失败" + (store.lastError ? "（" + store.lastError + "）" : ""));
  }

  let hit = lookupIndex(name);
  if (!hit) {
    // 静态目录是构建时的快照，新上线/换号的台会查不到 -> 重建一次再找
    await refreshIndexOnce(env);
    hit = lookupIndex(name);
  }
  if (!hit) throw new HttpError(404, "频道索引 " + name + " 未在 radio.cn 目录中找到");
  const [code, cid] = hit;

  let st = await getStationRow(env, code, cid, ctx);
  if (!st) {
    // 静态目录过期（台换省 / 换 contentId）：删掉这条重建一次，再按新映射试一遍
    await refreshIndexOnce(env, name);
    const again = lookupIndex(name);
    if (again) st = await getStationRow(env, again[0], again[1], ctx);
  }
  if (!st) throw new HttpError(404, "频道 " + name + " 无法续签（目录已变化）");

  const signed = pickSignedUrl(st, name);
  if (!signed) throw new HttpError(404, "频道 " + name + " 没有可用的播放地址");
  return [signed, st];
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- HLS 改写
const URI_ATTR = /(URI\s*=\s*)"([^"]*)"/g;

function rewritePlaylist(text, base) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) { out.push(line); continue; }
    if (s.startsWith("#")) {
      out.push(line.replace(URI_ATTR, (_m, k, v) => k + '"' + absUrl(v, base) + '"'));
    } else {
      out.push(absUrl(s, base));
    }
  }
  return out.join("\n") + "\n";
}

function absUrl(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

async function fetchUpstream(env, url, extraHeaders = {}) {
  const r = await fetchT(url, {
    headers: {
      "User-Agent": cfg(env).ua,
      Accept: "*/*",
      Referer: "https://www.radio.cn/",
      ...extraHeaders,
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  }, 8000);
  return { status: r.status, ctype: r.headers.get("Content-Type") || "", body: await r.text() };
}

const hasSegment = (text) =>
  text.split(/\r?\n/).some((ln) => ln.trim() && !ln.trim().startsWith("#"));

// ---------------------------------------------------------------- 响应helper
function send(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...CORS_HEADERS, ...headers } });
}

function sendJson(obj, status = 200, headers = {}) {
  return send(JSON.stringify(obj, null, 2), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
}

// 宽松解析：url 里可能带未编码的 &，所以不能直接用 URLSearchParams
function parseTarget(rawQs) {
  let mode = "proxy";
  let qs = rawQs || "";
  const m = qs.match(/(?:^|&)mode=([A-Za-z]+)(?=&|$)/);
  if (m) {
    mode = m[1].toLowerCase();
    qs = qs.slice(0, m.index) + qs.slice(m.index + m[0].length);
  }
  if (qs.startsWith("url=")) qs = qs.slice(4);
  else if (qs.includes("&url=")) qs = qs.split("&url=")[1];
  else if (qs.startsWith("id=")) qs = qs.slice(3);
  let target = qs.trim();
  try { target = decodeURIComponent(target); } catch { /* 保留原样 */ }
  return [target, mode];
}

const quote = (s) => encodeURIComponent(s || "");

// ---------------------------------------------------------------- 路由
async function handleM3u8(env, req, url, rawQs, ctx) {
  const [target, mode] = parseTarget(rawQs);
  const origin = url.origin;
  if (!target) {
    return sendJson({
      ok: false,
      error: "缺少 url 参数",
      example: origin + "/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8",
    }, 400);
  }

  let signed, station;
  try {
    [signed, station] = await resolveSignedUrl(env, target, ctx);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (status === 502) log("sign error: " + e.message);
    return sendJson({ ok: false, error: status === 502 ? "签名接口失败: " + e.message : e.message, url: target }, status);
  }

  const title = (station && station.title) || "";
  const signedPath = (() => { try { return new URL(signed).pathname.toLowerCase(); } catch { return ""; } })();
  const isHls = signedPath.endsWith(".m3u8") || signedPath.endsWith(".m3u");

  // 直连 mp3 / 非 HLS 流：不能缓冲代理，直接 302 让播放器自己连
  if (mode === "redirect" || !isHls) {
    return new Response(null, {
      status: 302,
      headers: { ...CORS_HEADERS, Location: signed, "Cache-Control": "no-store" },
    });
  }

  let body = "";
  const pl = store.lastPl;
  if (pl && pl.url === signed && Date.now() - pl.at < 5000) {
    body = pl.text;                       // probe 刚拉过，5 秒内直接复用
  } else {
    try {
      let r = await fetchUpstream(env, signed);
      // 未开播的台 CDN 会回 200 + 空 body，重试一次再判死，避免瞬时抖动误杀
      if (!r.body.trim()) {
        await sleep(550);
        r = await fetchUpstream(env, signed);
      }
      body = r.body;
      if (body.includes("#EXTM3U")) store.lastPl = { url: signed, text: body, at: Date.now() };
    } catch (e) {
      log("upstream error: " + e.message);
      return sendJson({ ok: false, error: "上游播放列表拉取失败: " + e.message, url: target }, 502);
    }
  }

  if (!body.includes("#EXTM3U") || !hasSegment(body)) {
    // 空列表 / 无切片 = 该台当前没在播。返回 502，播放器才能立刻跳下一个，而不是干等。
    const idx = target.split("?")[0].split("/").pop() || "";
    log("off-air: " + (title || idx) + " (" + target + ") body=" + body.length + "B");
    return sendJson({
      ok: false,
      error: "该电台当前没有节目（未开播或已停播）",
      station: title,
      index: idx,
      resolved: signed.split("?")[0],
      retry_after: 60,
    }, 502, { "X-Off-Air": "1", "Cache-Control": "no-store" });
  }

  const out = rewritePlaylist(body, signed);
  return send(out, 200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    "X-Station": quote(title),
  });
}

async function handleProbe(env, url, rawQs, ctx) {
  const [target] = parseTarget(rawQs);
  if (!target) return sendJson({ ok: false, error: "缺少 url 参数" }, 400);

  let signed, station;
  try {
    [signed, station] = await resolveSignedUrl(env, target, ctx);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    return sendJson({ ok: false, error: status === 502 ? "签名失败: " + e.message : e.message }, status);
  }

  const title = (station && station.title) || "";
  const playUrl = url.origin + "/m3u8?url=" + encodeURIComponent(target);
  const path = (() => { try { return new URL(signed).pathname.toLowerCase(); } catch { return ""; } })();

  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) {
    try {
      let r = await fetchUpstream(env, signed);
      if (!r.body.trim()) {
        await sleep(500);
        r = await fetchUpstream(env, signed);
      }
      if (r.body.includes("#EXTM3U") && hasSegment(r.body)) {
        // 暂存 5 秒，紧接着的 /m3u8 直接复用，省掉一次跨洋往返
        store.lastPl = { url: signed, text: r.body, at: Date.now() };
        return sendJson({ ok: true, kind: "hls", station: title, play: playUrl });
      }
      return sendJson({ ok: false, kind: "offair", station: title, error: "该电台当前没有节目" });
    } catch (e) {
      return sendJson({ ok: false, kind: "hls", error: "上游播放列表拉取失败: " + e.message }, 502);
    }
  }

  // mp3 / 其他直连流：探一小段字节，确认真的能取到音频
  // 注意：mp3 是无限流，绝不能 arrayBuffer() 把整个 body 读完（会永远挂住），
  // 只读开头 2KB 就 cancel。超时也覆盖读 body 这段，不是只管到响应头。
  try {
    const r = await fetchHead(signed, {
      "User-Agent": cfg(env).ua,
      Range: "bytes=0-2047",
      Referer: "https://www.radio.cn/",
    }, 2048, 8000);
    const ctype = (r.ctype || "").toLowerCase();
    const head = new TextDecoder().decode(r.buf.slice(0, 200)).toLowerCase();
    if (r.buf.length && !head.includes("<html")) {
      return sendJson({ ok: true, kind: "mp3", station: title, content_type: ctype, play: playUrl });
    }
  } catch (e) {
    if (cfg(env).debug) log("probe mp3 failed: " + e.message);
  }
  return sendJson({ ok: false, kind: "offair", station: title, error: "该电台当前没有节目" });
}

async function allStations(env, prov = "") {
  if (!(await ensureIndex(env))) throw new Error("频道目录构建失败");
  // 静态目录只带 basename 映射，不含频道详情，所以列表接口得现拉。
  // 指定了省就只拉那个省（1 个请求），要全量才拉 32 个。
  if (prov && prov !== "all") {
    if (!store.items.has(prov)) await refreshProvince(env, prov);
  } else if (store.items.size < store.provinces.length) {
    await buildIndex(env, true);
  }
  const names = new Map(store.provinces);
  const out = [];
  for (const [code, entry] of store.items) {
    for (const st of entry.rows) {
      const src = PREFER_FIELDS.map((f) => st[f]).find((v) => v) || "";
      const streams = [];
      for (const f of PREFER_FIELDS) {
        const b = basename(st[f] || "");
        if (b && !streams.includes(b)) streams.push(b);
      }
      out.push({
        title: st.title,
        contentId: String(st.contentId),
        province: names.get(code) || code,
        provinceCode: code,
        subtitle: st.subtitle,
        image: st.image,
        streams,
        source: src.split("?")[0],
        index: basename(src),
      });
    }
  }
  out.sort((a, b) => {
    const pa = a.provinceCode === "0" ? 0 : 1;
    const pb = b.provinceCode === "0" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.province !== b.province) return a.province.localeCompare(b.province, "zh");
    return String(a.title || "").localeCompare(String(b.title || ""), "zh");
  });
  return out;
}

async function handleStations(env, url, rawQs) {
  const prov = new URLSearchParams(rawQs).get("province") || "";
  const base = url.origin + "/m3u8?url=";
  let rows;
  try {
    rows = await allStations(env, prov);
  } catch (e) {
    return sendJson({ ok: false, error: e.message }, 502);
  }
  const out = [];
  for (const r of rows) {
    if (prov && prov !== "all" && r.provinceCode !== prov) continue;
    out.push({
      title: r.title,
      province: r.province,
      contentId: r.contentId,
      proxy: base + (r.source || "http://ytcast2.radio.cn/" + (r.index || "")),
      image: r.image,
      index: r.index,
      streams: r.streams,
    });
  }
  return sendJson({ ok: true, count: out.length, stations: out });
}

async function handleM3u(env, url, rawQs) {
  const prov = new URLSearchParams(rawQs).get("province") || "";
  const base = url.origin + "/m3u8?url=";
  let rows;
  try {
    rows = await allStations(env, prov);
  } catch (e) {
    return sendJson({ ok: false, error: e.message }, 502);
  }
  const lines = ["#EXTM3U"];
  const seen = new Set();
  for (const r of rows) {
    if (prov && prov !== "all" && r.provinceCode !== prov) continue;
    if (!r.index) continue;
    const key = r.title + "|" + r.index;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      '#EXTINF:-1 tvg-name="' + (r.title || "") + '" tvg-logo="' + (r.image || "") +
      '" group-title="' + (r.province || "") + '",' + (r.title || "")
    );
    lines.push(base + (r.source || "http://ytcast2.radio.cn/" + r.index));
  }
  return send(lines.join("\n") + "\n", 200, {
    "Content-Type": "audio/x-mpegurl; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>radio.cn 签名代理</title>
<style>body{font:15px/1.7 -apple-system,"Microsoft YaHei",sans-serif;margin:40px;max-width:820px}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style>
<h2>radio.cn 云听 HLS 签名代理</h2>
<p>用法:<br><code>https://HOST/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8</code></p>
<p>可选参数:<code>&amp;mode=redirect</code> 返回 302 直连 CDN;默认代理播放列表并自动续签。</p>
<p><a href="/stations">/stations</a> 频道列表 · <a href="/radio.m3u">/radio.m3u</a> M3U 订阅 ·
<a href="/healthz">/healthz</a> 健康检查</p>`;

// ---------------------------------------------------------------- 入口
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    store.origin = url.origin;   // Cache API 的键必须与请求同源
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const rawQs = url.search.replace(/^\?/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson({ ok: false, error: "只支持 GET / HEAD" }, 405);
    }

    const c = cfg(env);
    if (!c.key) {
      return sendJson({
        ok: false,
        error: "未配置 SIGN_KEY（Cloudflare 后台 Variables 或 wrangler secret put SIGN_KEY）",
      }, 500);
    }

    let res;
    try {
      if (path === "/" || path === "/index.html") {
        res = send(INDEX_HTML, 200, { "Content-Type": "text/html; charset=utf-8" });
      } else if (path === "/healthz") {
        res = sendJson({
          ok: true,
          ready: isComplete(),
          stations: store.index.size,
          provinces: store.provinces.length,
          done: store.done.size,
          snapshot: STATIC_CATALOG_AT,
          snapshotAgeDays: snapshotAgeDays(),
          api: c.api,
          runtime: VERSION,
          build: BUILD,
        });
      } else if (path === "/refresh") {
        // 强制重抓 32 个省的目录（约 30 个请求 / 10 秒）。
        // 平时用不着：静态目录查不到的台会自动兜底重建。发现某台长期失效时可以手动点一次。
        const t0 = Date.now();
        let ok = false;
        try {
          await buildIndex(env, true);
          ok = true;
        } catch (e) {
          store.lastError = (e && e.message) || String(e);
        }
        res = sendJson({
          ok,
          stations: store.index.size,
          provinces: store.done.size,
          ms: Date.now() - t0,
          error: ok ? undefined : store.lastError,
          hint: "重抓后的结果只存在当前实例内存里，要长期生效请跑 gen_catalog.py 重新生成静态目录",
        });
      } else if (path === "/warm") {
        // 预热目录表。免费版 10ms CPU 一次可能建不完，重复访问几次即可（断点续建）。
        const ok = await ensureIndex(env);
        res = sendJson({
          ok,
          ready: isComplete(),
          done: store.done.size,
          provinces: store.provinces.length,
          stations: store.index.size,
          hint: isComplete() ? "目录已就绪" : "未建完，再访问一次 /warm",
        });
      } else if (path === "/stations" || path === "/stations.json") {
        res = await handleStations(env, url, rawQs);
      } else if (path === "/radio.m3u" || path === "/list.m3u") {
        res = await handleM3u(env, url, rawQs);
      } else if (path === "/probe") {
        res = await handleProbe(env, url, rawQs, ctx);
      } else if (["/m3u8", "/live", "/hls", "/play"].includes(path)) {
        res = await handleM3u8(env, request, url, rawQs, ctx);
      } else {
        res = send("404 not found\n", 404, { "Content-Type": "text/plain; charset=utf-8" });
      }
    } catch (e) {
      log("unhandled: " + (e && e.stack ? e.stack : e));
      res = sendJson({ ok: false, error: "内部错误: " + (e && e.message ? e.message : e) }, 500);
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: res.status, headers: res.headers });
    }
    return res;
  },
};
