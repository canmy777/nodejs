# Kata-Tunnel（kata-nodejs）使用与部署说明

原生 Node.js 实现的 VLESS over WebSocket 隧道服务，带用户管理、订阅导出、三网优选节点池和可选 Cloudflare Tunnel。无第三方运行依赖，适合小内存容器（KataBump / Lunes Host / 翼龙面板）。

仓库位置：`https://github.com/hc990275/nodejs` 的 `kata-nodejs/` 目录。

## 1. 文件结构

```text
kata-nodejs/
├── index.js          # 主程序（必须）
├── package.json      # 启动与测试脚本（必须）
├── .env.example      # 配置模板（部署时复制为 .env）
├── src/
│   ├── argo-supervisor.js # 隧道进程监管与就绪探测（必须）
│   ├── probe-manager.js # 探针命令管理与进程生命周期（必须）
│   ├── probe-routes.js  # 管理鉴权、上传及执行接口（必须）
│   ├── komari-manager.js # Komari 上传校验与私有配置（必须）
│   ├── security.js      # 密码哈希、会话、限速（必须）
│   ├── protocol.js      # WebSocket/VLESS 协议解析（必须）
│   ├── sub_converter.js # 现代订阅转换引擎：6 格式 + ECH 规范（必须）
│   └── yaml-lite.js     # 零依赖 YAML 序列化，供 sub_converter 生成 Clash 配置（必须）
├── test/             # 回归测试，仅本地运行，不必上传
└── data/             # 运行时生成，保存用户与设置
```

注意：`src/` 全部模块必须一起上传，只传 `index.js` 会因为缺少依赖而启动失败。

## 2. 环境要求

- Node.js 20 或更高版本（推荐 24）
- 无 npm 运行依赖，无需 `npm install`
- 端口：由面板注入，或手动在 `.env` 配置

## 3. 本地启动

```sh
git clone https://github.com/hc990275/nodejs.git
cd nodejs/kata-nodejs
cp .env.example .env
# 编辑 .env，按需配置（见第 6 节）
npm test          # 运行当前完整回归测试
npm start         # 启动
```

启动后访问：

- 首页：`http://服务器地址:端口/`
- 管理后台：`http://服务器地址:端口/admin`

服务监听 `0.0.0.0`。本地测试请通过防火墙或隔离环境限制访问。

## 4. 面板部署（KataBump / Lunes / 翼龙）

1. 新建服务器，选择 Node.js 运行环境，记下面板分配的业务端口（SFTP 端口与业务端口不同）。
2. 用面板 Settings 里给出的 SFTP 主机、端口、用户名、密码连接。SFTP 根目录通常对应 `/home/container`。
3. 上传这些文件到容器根目录：`index.js`、`package.json`、整个 `src/` 目录。首次部署把 `.env.example` 复制为 `.env` 并填写配置。不要上传整个父目录，也不要上传 `test/`。
4. 端口：面板注入 `SERVER_PORT` 时，`.env` 里的 `SERVER_PORT`、`PORT` 留空即可；程序会自动探测面板端口（进程环境变量 → `/proc` → 命令行 → 模糊匹配）。手动部署才需要显式填写。不再有固定默认端口，探测不到端口时服务挂起等待。
5. 启动命令填写：`node --max-old-space-size=96 /home/container/index.js`（或在项目根目录用 `npm start`）。
6. 点击启动，查看控制台是否出现核心启动标记，然后打开首页与 `/admin`。观察约两分钟确认稳定，不要只看面板 Running。
7. 公网建议通过自己的 HTTPS 反代或 Cloudflare Tunnel 访问。

## 5. 首次设置管理员密码

两种任选其一：

- 已在 `.env` 或运行环境预置 `ADMIN_PASSWORD` 时，使用现有密码从 HTTPS 后台登录。
- 首次部署可将 `ADMIN_PASSWORD` 留空或省略。在 `.env` 填入 `ADMIN_SETUP_TOKEN`，使用 `openssl rand -hex 24` 生成随机口令。如果反代改写回源的 `Host`，请先把对外域名填入 `SUB_DOMAIN` 或 `ARGO_DOMAIN`。通过 HTTPS 打开 `/admin`，输入初始化口令并设置 10 至 256 位的管理员密码。保存成功后密码写入 `.env`，文件中的初始化口令清空，首次设置入口关闭。

## 6. 配置项说明（.env）

复制 `.env.example` 为 `.env` 后按需修改：

| 配置键 | 用途 |
| --- | --- |
| `SERVER_PORT` / `PORT` | 业务端口。面板注入时留空，程序自动探测；手动部署才填 |
| `ADMIN_PASSWORD` | 管理员密码。留空则走首次设置向导（见第 5 节） |
| `SUB_DOMAIN` | 首选公网域名或 IP。留空时自动使用隧道域名 `ARGO_DOMAIN`，无隧道则自动探测公网 IPv4 |
| `SERVER_IP` | 公网 IPv4 回退值。留空时自动探测（无需手动填） |
| `DEFAULT_ALLOW_REGISTER` | 首次启动是否开放注册，`true` / `false` |
| `DEFAULT_DAYS` | 新注册用户默认有效天数 |
| `DEFAULT_TRAFFIC_GB` | 新注册用户默认流量（GB） |
| `IP_REGISTER_COOLDOWN_SEC` | 同 IP 两次注册的间隔秒数 |
| `IP_DAILY_REGISTER_LIMIT` | 同 IP 24 小时注册上限 |
| `ARGO_TOKEN` | 可选，Cloudflare Tunnel Token，填了才会启动隧道进程 |
| `ARGO_DOMAIN` | 可选，隧道公开域名；未填隧道域名时订阅不会生成隧道节点 |
| `ENABLE_ECH` | 是否启用 ECH，`true` / `false` |
| `ECH_SNI` | ECH 查询用的 SNI 域名 |
| `ECH_DNS` | 查询 ECH 配置的 DoH 地址 |
| `CLIENT_FINGERPRINT` | TLS 客户端指纹（如 chrome） |
| `SUBAPI` | 订阅转换后端，`local` 表示本地转换 |
| `SUBCONFIG` | Clash 分流规则模板地址 |
| `WETEST_API_URL` | 三网优选 API 地址，留空则不拉取 |

说明：

- 后台"系统设置"里修改的配置会自动写回 `.env` 并热加载，无需重启。
- 隧道 Token：未填时不启动隧道进程；在后台填入并保存后会自动拉起/重载隧道；只改 Token 才会重启隧道，Token 不变只改域名不会重启。
- 域名只能手动填，程序无法从 Token 反推域名。
- 订阅节点不写入固定 ALPN，保证 ECH 正常协商。

## 7. 管理后台与用户操作

打开 `/admin` 登录后可：

- **添加用户**：填用户名、密码（至少 10 位）、有效天数、流量配额。密码留空会生成一次性随机临时密码，请立即保存。
- **用户列表**：紧凑表格，手机端三列显示「账号名称 / 已用流量 / 在线」。用户名带虚线框，点击直接打开编辑框。列表默认按在线连接数从多到少排序，点击表头「已用流量」「在线」「注册时间」可切换升降序。支持搜索、分页（每页 5 条）。
- **在线徽章**：绿色圆点 + 数字表示当前连接数；未显示数字表示离线。
- **封禁/解封/续期/删除**：在用户编辑框内操作。封禁和删除会断开该用户连接。
- **重启核心**：顶部工具栏按钮，会重启 Node 服务，影响所有在线连接，请在维护时段使用。

### 探针管理

当前候选版本 `2.0.0-test.1` 提供后台「探针管理」，本地验证后仍需单台容器验收再推广。推荐使用 Komari 专用流程：

1. 从可信发布方取得 Linux `komari-agent` 程序及对应 SHA-256，选择文件并填入校验值，输入当前管理密码后上传。单文件上限 32 MiB、上传限时 90 秒；服务端流式写入、验证 ELF 及容器架构（amd64/arm64/386/arm）并核对 SHA-256，失败不会替换现有程序。SHA-256 只能证明与所填校验值一致，不能单独证明来源可信。
2. 填写 HTTPS 监控面板地址，选择节点 Token 或自动发现密钥并输入凭据，再保存。Token 不回显，留空保留已有值；切换凭据类型或面板时须重新填凭据。输入的凭据不进入日志、进程参数或状态 API。
3. 点击「启动 Komari」并确认。专用模式使用私有 JSON 配置运行、关闭远程终端和自动更新，与高级命令共用一个运行槽，不允许并发；通过「停止」结束。显示“运行中”只表示本地进程，面板是否收到上报须另外核验。
4. 「随应用启动」默认关闭。勾选保存后，下一次 Node 服务成功监听时自动尝试启动一次；上传、保存本身不启动，失败不会无限重试，手动停止后本次运行期不会自动重拉。容器或 Node 退出时一起清理。

探针和连接配置位于 `data/probe-private/`；元数据及配置文件 0600，目录与程序 0700。自动发现缓存按面板和凭据隔离在 `profile-*/` 内，程序替换保留原缓存；更换连接身份生成新 profile，不自动删除旧私有资料。该目录不进入 Git、普通归档或聊天。

高级模式仍支持粘贴命令或从 `.sh/.txt` 导入（16 KiB 内），保存后单独点击「执行」，也可查看状态或停止。上传、保存、启动、执行及停止均要求有效管理会话、合法 HTTPS Origin 与重新输入当前管理密码；执行前有确认框，同一时刻只运行一个任务，配置版本变化会拒绝执行旧版本。

- 命令保存到 `data/probe-private/command.json`，目录 0700、文件 0600，并原子替换。该文件可能含凭据，属于私有运行配置，禁止加入 Git、普通备份或发给其他人；页面与状态 API 不回显命令。
- 执行工作目录为 `data/probe-private/`，通过 Bash（没有时用 sh）的 stdin 传入命令，不把命令放到系统进程参数。不会继承应用的 Token、密码或 `NODE_OPTIONS` 环境变量；这不是沙箱，同一容器用户仍能读取其有权限的文件并访问网络。
- 默认最多执行 300 秒，可设 10–1800 秒；设为 0 可运行前台常驻探针，直到手动停止或应用关闭。输出超过 1 MiB 会终止。原始 stdout/stderr 直接丢弃，不写应用日志或返回浏览器；仅保留本次状态、时间、输出字节数和退出码，状态记录只在内存中。
- 点击停止、超时、输出超限、应用正常关闭都会先终止当前进程组，必要时强制终止。高级命令保存及应用重启均不会自动执行；Komari 专用模式只按显式开启的自动启动选项执行。只管理自己启动的当前进程组，不按历史 PID 杀进程。
- 适用于容器权限下的前台安装/检查任务。需要 sudo/root、systemd/OpenRC 的宿主机安装命令不能直接套用。常驻探针应设为 0 并在前台运行；设置正数时达到时限会停止。自行 daemonize/setsid 脱离的子进程不受管理器控制，不应使用此类命令。安装退出码 0 仅表示命令结束，不代表探针已向监控面板注册上线。

接口：`GET /admin/api/probe/status`；`POST /admin/api/probe/komari/config`（endpoint/token/credentialType/autoStart/password）；`POST /admin/api/probe/komari/start`（revision/password）；`POST /admin/api/probe/komari/upload`（原始 application/octet-stream；X-Probe-Sha256、X-Probe-Password 请求头，密码使用 encodeURIComponent 编码）；`POST /admin/api/probe/config`（高级 command/timeoutSeconds/password）；`POST /admin/api/probe/run`（revision/password）；`POST /admin/api/probe/stop`（共用停止入口，password）。不提供通过 GET 触发执行的入口。

Komari 配置字段及自动发现缓存行为按官方 `komari-agent` 1.6.20 的 `cmd/flags/flag.go` 和 `cmd/autodiscovery.go` 核对。其他版本仍须先验证兼容；当前测试使用模拟 ELF 程序，不表示已向真实监控面板注册。

## 8. 订阅地址

格式：`/sub?token=用户UUID`

可附加参数切换格式（不带参数时按客户端 UA 自动识别，识别不了落到通用 Base64）：

| target | 格式 | 适用客户端 |
| :--- | :--- | :--- |
| `base64`（默认） | 通用 VLESS URI（标准 ECH 字段） | v2rayN / v2rayNG / Shadowrocket / Hiddify / Karing |
| `clash` | Mihomo / Clash Meta YAML | Clash Verge Rev / Clash Party / FlClash / CMFA / Stash / OpenClash |
| `singbox` | sing-box JSON | sing-box 官方 / Throne / GUI.for.SingBox |
| `surge` | Surge 配置 | Surge（Mac/iOS）/ Surfboard |
| `qx` / `quantumultx` | Quantumult X 配置 | Quantumult X |
| `loon` | Loon 配置 | Loon（iOS/tvOS） |

该订阅转换引擎从 liuyang 导航站移植，ECH 字段已按各客户端官方规范处理（Base64 用 `ech`、Clash 用 `ech-opts`、sing-box 用 `tls.ech` 无 enabled 字段；Surge/QX/Loon 不支持 ECH 则降级为普通 TLS）。UUID 是访问凭据，不要公开分享。

## 9. 更新与备份

1. 更新前备份线上 `index.js`、`package.json`、`src/`，以及私下的 `.env`、`data/`。
2. **升级时保留现有 `.env` 和 `data/`，不要用示例覆盖。**
3. 上传新版本源码文件，校验，重启，查看控制台和页面。
4. 失败时恢复旧文件并重启；恢复用户数据请选对备份版本。

说明：`data/users.json` 保存密码哈希、UUID、流量；`.env` 含 Token。这些文件不要提交 Git 或贴到公开日志。会话在内存，重启需重新登录；旧 SHA-256 密码在登录成功时自动迁移为 PBKDF2。

## 10. 测试与排障

```sh
node --check index.js
npm test
```

- 模块找不到：补传 `src/` 全部模块（包括探针管理三个模块），检查大小写与目录层级。
- 页面打不开：确认业务端口、容器监听、防火墙、域名回源端口一致。
- 无法登录或提示 429：核对管理员密码，等待限速窗口结束；若开启 `NODE_ENV=production`，必须用 HTTPS 登录。
- 订阅不可用：检查用户是否被封禁/到期/超额，再检查域名、TLS、WebSocket 回源和客户端能力。
- 隧道不通：确认 `ARGO_TOKEN` 与 `ARGO_DOMAIN` 都已填写并保存；Token 才触发隧道拉起。
- 面板提示"停止 60 秒后再重启"：视为启动失败，先读控制台错误，修复后再启动。

### 隧道启动、停止与自愈

后台 Token 输入框留空会保留已有值。提交不同的 Token 会等旧连接进程退出，再启动新进程。将 `.env` 中的 `ARGO_TOKEN` 显式置空可停止隧道。运行时环境变量用于没有该配置项的部署。

程序通过 cloudflared 的回环 `/ready` 接口检测边缘连通性。退出会按 3 到 60 秒退避重试，连续就绪失败且启动宽限期已过会重启当前连接进程。公开域名和实际回源还需独立验收。
