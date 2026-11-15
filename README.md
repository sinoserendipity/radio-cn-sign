# radio.cn（云听 / 央广）HLS 签名代理

[![Docker](https://github.com/sinoserendipity/radio-cn-sign/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/sinoserendipity/radio-cn-sign/actions/workflows/docker-publish.yml)

给 `ytcast2.radio.cn` 的广播 m3u8 自动签名 + 自动续签的代理，跑起来就能用固定地址收听：

```
http://<宿主机IP>:8090/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8
```

（容器内监听 8090，宿主机端口随便映射；被占用就改 `ports:` 左边。）

## 为什么需要它

1. `ytcast2.radio.cn` 的播放列表**必须**带令牌 `?type=1&key=<md5>&time=<hex秒>`，裸地址直接 403。
2. 令牌里的 `key` 是把 **CDN 路径** 参与计算的（同一个 key 换个路径就失效），所以没法本地算，只能向官方网关要。
3. 网关：`https://ytmsout.radio.cn/web/appBroadcast/list?categoryId=0&provinceCode=<省>`
   请求头签名：
   ```
   sign      = UPPER(MD5("categoryId=0&provinceCode=<省>&timestamp=<毫秒>&key=<SIGN_KEY>"))
   timestamp = <毫秒>
   platformCode: WEB
   equipmentId: 0000
   Content-Type: application/json
   ```
   返回的 `mp3PlayUrlHigh / playUrlMulti / mp3PlayUrlLow / playUrlLow` 就是带新令牌的地址。
4. 切片（`.ts`）**不需要**令牌，所以本代理只代理很小的播放列表文本，音频数据直连 CDN，不吃路由器带宽。

## 工作流程

```
播放器 ──GET /m3u8?url=…index_40639.m3u8──▶ 代理
                                             │ 1. 取 basename → index_40639.m3u8
                                             │ 2. 查目录缓存 → (省, contentId=639)
                                             │ 3. 调网关拿**新鲜**带令牌地址（30s 内复用）
                                             │ 4. 拉取该 m3u8，把相对切片改写成 CDN 绝对地址
播放器 ◀──m3u8(切片已是 CDN 绝对地址)───────┘
播放器 ──GET segment….ts──────────────────────▶ CDN（不带令牌也能取）
```

播放器每次刷新播放列表都会再打一次代理 → 每次都是新令牌 → **自动续签**，不会中途断流。

## 部署

### 1. 准备密钥（一次性）

```bash
cp .env.example .env    # 然后填 SIGN_KEY
```

`SIGN_KEY` 是云听网页端接口的签名密钥（从前端 JS 里取），**不随仓库发布**：compose 从 `.env` 读，`.env` 已在 `.gitignore` 里。

### 2. docker compose（推荐）

```bash
docker compose up -d          # 直接用 CI 构建好的镜像
docker compose up -d --build  # 或者本地从源码构建
```

### 3. 或者一条 docker run

```bash
docker run -d --name radio-cn-sign --restart unless-stopped \
  -p 8091:8090 \
  -e SIGN_KEY='<你的 SIGN_KEY>' \
  ghcr.io/sinoserendipity/radio-cn-sign:latest
```

### 4. 拉不动 ghcr.io 的机器（家用路由器/NAS 常见）

每次构建都会额外产出离线镜像包，从 Actions 运行的 Artifacts 里下载对应架构：

```bash
docker load -i radio-cn-sign-amd64.tar.gz     # 或 arm64
```

镜像基于 `python:3.12-alpine`，**不需要 pip 安装任何依赖**（纯标准库），约 50 MB。默认以 uid 10001 非 root 运行，自带 HEALTHCHECK。

## 用法

| 地址 | 说明 |
|---|---|
| `/m3u8?url=http://ytcast2.radio.cn/index_40639.m3u8` | 中国之声（默认代理模式，自动续签） |
| `/m3u8?url=…&mode=redirect` | 返回 302，播放器直连 CDN（省 CPU，但续签取决于播放器是否重走原地址） |
| `/m3u8?id=40639` | 懒得写全地址时用频道流号 |
| `/m3u8?url=<带旧令牌的地址>` | 旧地址里的 `?type=1&key=…&time=…` 会被丢掉并重新签，所以**过期的播放列表也能救活** |
| `/stations` | 全部频道 JSON（含代理地址、台标、省份），`?province=440000` 过滤，`?province=0` 只看央广 |
| `/radio.m3u` | M3U 订阅（可 `?province=all`），丢进播放器/电视盒子即可 |
| `/healthz` | 健康检查，含缓存频道数 |

支持未编码的 `&`（`url=http://…?type=1&key=x&time=y` 原样贴进来也能解析）。非 HLS 的直连 mp3 台（如 `stream_11849.mp3`）一律 302 直达，不做缓冲。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIGN_KEY` | （必填） | 网页端接口签名密钥 |
| `API_BASE` | `https://ytmsout.radio.cn` | 备用网关 `https://ytmsotherout.radio.cn` |
| `PORT` / `BIND` | `8090` / `0.0.0.0` | 容器内监听 |
| `RESIGN_WINDOW` | `30` | 同一频道复用已签地址的最长秒数（每次超时就重新请求网关） |
| `CATALOG_TTL` | `900` | 全量频道表刷新间隔（32 个地区 × 1 次请求） |
| `UPSTREAM_TIMEOUT` | `8` | 上游超时秒数 |
| `LOG_REQUESTS` | `1` | 访问日志 |
| `DEBUG` | `0` | 打印每条续签结果 |

## CI（GitHub Actions）

`.github/workflows/docker-publish.yml`：

| 触发 | 行为 |
|---|---|
| push 到 `main` | 构建 `linux/amd64` + `linux/arm64`，推 `:edge` `:sha-xxxxxxx`，并各出一份离线 tar 包 |
| push tag `v1.2.3` | 同样构建推送，额外打 `:1.2.3` `:1.2` `:latest` |
| Pull Request | 只构建 amd64、不推送，起容器打 `/healthz` 做 smoke test |
| 手动 `workflow_dispatch` | 同分支 push |

发版就是打 tag：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

镜像推到 GHCR：`ghcr.io/sinoserendipity/radio-cn-sign`（用自带 `GITHUB_TOKEN`，无需额外 secret）。

## 注意

- **OpenWrt/iStoreOS 上 compose 自建 bridge 通常没有外网**（容器内报 `Connection refused`），所以 `docker-compose.yml` 里写死了 `network_mode: bridge`，别删。
- 频道是**按索引文件名**（`index_40639.m3u8` / `stream_11849.mp3`）匹配的，官方每个台有 3~4 个不同码率的索引文件，分别对应 `playUrlLow / mp3PlayLow / mp3PlayHigh`，所以贴哪个都能对上号。
- 目录缓存在容器启动时后台构建（约 2750 个流、32 次请求），`/healthz` 的 `ready` 变 `true` 才好用；没找到的频道会触发一次强制重建再判定 404。
- 令牌有效期官方没写明，实测至少几分钟；`RESIGN_WINDOW=30` 只是省请求，不影响正确性。
- 服务本身**没有鉴权**，只应暴露在局域网；别在路由器上做 WAN 端口映射，否则等于把签名接口送人。
