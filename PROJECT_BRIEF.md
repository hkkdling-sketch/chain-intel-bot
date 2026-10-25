# 链上情报 Bot · 完整项目方案（交给其他 AI 评估用）

> 这份文档是自包含的：读者无需任何前置对话上下文。
> 最后更新：2026-10-25 ｜ 代码位置：`C:\Users\25675\WorkBuddy AI\2026-09-17-00-00-38\crypto-bot`

---

## 0. 一句话概括

一个 **Telegram 加密行情/情报推送机器人**，Node.js 零依赖实现，免费数据源拼装，
通过频道订阅 + USDC 月费变现。当前已完成开发与本地验证，**待部署到 InstaBox 免费云机器**。

**用户背景**（影响技术选型的关键约束）：
- 大专在校生，启动资金约 500 元人民币，**预算极低，只能用免费资源**
- Windows 本地开发，云端是 Linux（Debian 13）
- 手上**还有其他项目要跑**（AI agent 网关、任务类 agent 等），但免费云只有 1 台机器
- 英语可读写，目标受众是中文加密用户（Telegram）
- 对安全敏感：botToken 曾明文暴露过，现已改走环境变量

---

## 1. 产品与商业模式

### 1.1 内容分档

| 档位 | 内容 | 目标 |
|---|---|---|
| **免费档**（公开频道） | 市值前 10 行情 + 热度/涨幅榜 + 全球总市值 + BTC 占比 + **1 条头条**（钩子） | 拉新、维持频道活跃 |
| **会员档**（付费频道） | 上述全部 + 会员专享（24h 异动榜、新晋热点）+ **完整情报速递**（4 条）+ **深度解读**（Exa 语义搜索 2 条） | $9/月 USDC 变现 |

### 1.2 分发规则（代码已实现）

- `chatId` 是**频道**（`@handle` 或 `-100…`）且未配 `memberChatId` → **只发免费版**（防止会员内容白送）
- `chatId` 是**私人号**（正数）→ 发全部内容（自测用）
- 配了 `memberChatId` → 免费版发公开频道 + 会员广告尾巴，完整版发会员频道

### 1.3 收款

USDC 直接收款（EVM 地址），人工确认后手动拉人进会员频道。
**没有自动化支付验证**，是 MVP 阶段的人工环节。

---

## 2. 技术架构

### 2.1 运行时与依赖

- **Node.js >= 18**（用了原生 `fetch`、ESM、top-level await）
- **零 npm 运行时依赖**（package.json 里没有 dependencies）—— 刻意设计，降低部署复杂度
- 唯一的外部二进制依赖：**mcporter**（仅"深度解读"模块用，可选，缺失时该模块静默跳过）

### 2.2 模块职责表

| 文件 | 行数 | 职责 | 关键设计 |
|---|---|---|---|
| `src/bot.js` | ~290 | 入口编排 + 惰性推送 + 消息分片发送 | 每路独立 `catch`；4096 分片；429 重试 |
| `src/config.js` | ~50 | 统一配置：**环境变量优先，回退 config.json** | 本地零感知；云端只给 env |
| `src/state.js` | ~45 | 状态目录 + 上次推送时间戳 | `STATE_DIR` 可指向持久盘；三模块共用 |
| `src/fetch.js` | ~550 | 行情层：8 个行情源 / 4 个涨幅源 / 3 个全球源 | 多源自动降级 + **源记忆** + 负缓存 + 同层并发赛跑 |
| `src/intel.js` | ~300 | 情报层：4 个 RSS 源 + Jina Reader + Exa 搜索 | 零依赖 RSS 解析；按源限流（每源最多 2 条）；已读去重 |
| `src/premium.js` | ~75 | 会员档数据：异动预警、新晋热点 | 空投模块**已停用**（见 §6 遗留问题） |
| `src/format.js` | ~70 | Telegram HTML 格式化 | 过滤稳定币与代币化股票（`FIGR_HELOC` 这类下划线 ticker） |
| `src/keepalive.js` | ~80 | HTTP 健康检查端点（云端保活用） | `/ping` 需 key，未配置则 403；返回 lastPush 状态 |
| `ecosystem.config.cjs` | ~70 | pm2 守护 bot + keepalive | 崩溃自动重启 + 指数退避 + **自加载 .env** |
| `.github/workflows/instabox-resume.yml` | ~60 | 每 4 小时调 API 唤醒被暂停的机器 | 需 GitHub Secrets 存 key 与 machine id |

### 2.3 数据流

```
                ┌─ fetch.js  fetchMarkets()  ──┐
                │   8 源降级 / 源记忆 / 30s 缓存 │
                ├─ fetch.js  fetchTrending() ──┤
                │   3 源降级 → 热度榜 or 涨幅榜  │
  bot.js ───────┼─ fetch.js  fetchGlobal()  ───┼──> format.js ──> 拼装 ──> Telegram API
  (runOnce)     │   3 源赛跑 / 4s 超时        │
                ├─ intel.js  fetchFreshNews() ─┤
                │   4 RSS 源 + 已读去重        │
                └─ intel.js  fetchDeepDive() ──┘
                    mcporter → Exa 语义搜索（可选）
```

### 2.4 容错策略（这是本项目最值得看的部分）

1. **多源降级**：每个板块配 2~8 个免费源，按 tier 分组，同层并发赛跑，谁先返回有效数据用谁
2. **源记忆**：上次成功的源记录在 `state/market-source.json`，下轮优先试它（热启动几百毫秒）
3. **负缓存**：所有源都失败时记录时间戳，30 分钟内不再重试（避免每轮白等 7 秒超时）
4. **板块级降级**：全球总览拿不到 → 跳过那两行；情报拿不到 → 少一块；深度解读失败 → 整块消失。**任何一块失败都不会导致整条推送失败**
5. **抓取去重**：同一次运行内 `fetchMarkets()` 用 in-flight Promise 缓存，多个模块共享一次请求

### 2.5 外部数据源清单（全部免费、无需 API key）

**行情**：CoinGecko / Coinlore / CoinPaprika / OKX / Gate.io / Binance / `data-api.binance.vision`（币安官方公开镜像，境内可达）/ CoinCap
**新闻**：Cointelegraph / Decrypt / The Block / Bitcoin Magazine 的 RSS
**深读**：`r.jina.ai`（网页转正文，免费）
**深度解读**：Exa 语义搜索，通过 `mcporter` CLI 调用（**有免费额度限制，会限流**）

> 实测背景：用户在中国大陆，CoinGecko 官方域名常被 DNS 污染，所以才有这么厚的降级层。

---

## 3. 运行方式

```bash
npm start          # 常驻：每 5 分钟自检，距上次成功推送 ≥ SCHEDULE_MINUTES 才推（当前 720 = 12h）
npm run once       # 立刻强制推一次，不看间隔（手动补发用）
npm run dry        # 只打印不发送，且**不写时间戳**（改代码后先用这个验证）
npm run serve      # 只起 keepalive 端点（云端配合 pm2 用）
```

> **惰性推送**：不用 `setInterval(12h)`，而是每 5 分钟读 `state/schedule.json` 判断「该不该推」。
> 机器被暂停 8 小时后唤醒，5 分钟内自动补推；进程重启也不会重复推。
> `--dry` 刻意不写时间戳，否则本地试跑一次会让真机 12 小时不推。

### 3.1 配置项（env 或 config.json 均可）

| 变量 | 说明 | 当前值 |
|---|---|---|
| `TG_BOT_TOKEN` | Telegram bot token | 已配（不入库） |
| `TG_CHAT_ID` | 公开频道/群 ID | `@mflsqb`（公开频道形态） |
| `TG_MEMBER_CHAT_ID` | 会员频道 ID（可选） | 未配 |
| `SCHEDULE_MINUTES` | 推送间隔 | 720 |
| `STATE_DIR` | 状态目录（云端指向持久盘 `/data/...`） | 未设（默认 `<项目>/state`） |
| `USDC_RECEIVE_ADDRESS` | 收款地址 | 已配（不入库） |
| `USDC_MONTHLY_PRICE` | 月费 | 9 |
| `KEEPALIVE_PORT` | 保活端点端口 | 8080 |
| `KEEPALIVE_KEY` | 保活密钥（`/ping` 必须带） | 待生成 |
| `MCPORTER_CLI` | mcporter CLI 绝对路径（可选覆盖） | 未设，走硬编码候选 |

---

## 4. 部署目标环境：InstaBox 免费档（真实限制）

InstaBox 是 YC P26 团队 InsForge 的产品，给 AI Agent 用的云电脑，2026-10 开 beta，免费期不计费。

| 项目 | 免费档实际额度 |
|---|---|
| 机器数 | **1 台**（暂停/停止也占名额） |
| 规格 | **4 vCPU / 8 GiB**（唯一可选规格） |
| 磁盘 | 系统盘 16 GiB（`/`，可能重置）+ 持久盘 20 GiB（`/data`，home 在 `/data/home`） |
| 存储池 | 200 GB（快照 + 机器文件共用） |
| 快照 | 5 个 |
| 模板 | **仅 `agent-browser`**：Debian 13 / kernel 6.18 / 预装 Node 22 + npm + git + Docker + Compose + Claude Code + Codex + VNC 桌面 |
| **闲置暂停** | **30 分钟，固定不可改**（付费才能调或关闭） |
| **运行上限** | **连续运行 8 小时后暂停**（控制台文案，官方文档尚未同步） |
| 公网端口 | 16 个/台，任意端口可得 HTTPS URL |
| API key | 20 个，Agent 可调接口开关机 |
| 单命令超时 | 10 分钟 |
| 计费 | 不计费（官方原话 "Free until we figure it out"，定价未定） |

### 4.1 关键机制：暂停 ≠ 关机

- **暂停（pause/suspend）**：内存 + 进程 + 文件全保留，恢复后原样继续，pm2 和 bot 不用重装
- **停止（stop）**：进程全没，只剩文件
- 官方文档明确：**「访问公网端口 URL 会唤醒闲置暂停的机器」**

### 4.2 保活方案（两道防线）

```
        ┌─ 防线1：UptimeRobot 每 5 分钟 GET /ping?key=xxx ──> 破「闲置 30 分钟」
外部 ───┤
        └─ 防线2：GitHub Actions 每 4 小时 POST /resume ───> 破「运行 8 小时」
```

- **防线 1 已确认原理成立**（官方文档写了访问端口会唤醒）
- **防线 2 是兜底**：8 小时暂停后 ping 能否唤醒**尚未实测**，不能唤醒就靠 Actions 调 API
- 手动续命命令：
  ```bash
  curl -X POST "https://api.instabox.sh/v1/machines/<id>/resume" \
    -H "X-API-Key: <key>" -H "Idempotency-Key: $(uuidgen)"
  ```

---

## 5. 当前进度

### ✅ 已完成

- 全部业务代码，本地 `--dry` 验证通过（8 个行情源、4 个 RSS 源、格式化、分档逻辑均正常）
- 配置改造：环境变量优先（`src/config.js`），本地 `config.json` 向后兼容
- **惰性推送已实现并验证**：造 `schedule.json` 后重启显示 `[SKIP] 距上次 0 分钟 < 720`；`--dry` 确认不写时间戳
- **`STATE_DIR` 全链路生效**：实测 `STATE_DIR=./custom-state` 时 fetch/intel/premium 三处状态文件都落在该目录
- **部署静默失败风险已消除**：`ecosystem.config.cjs` 自己加载 `.env`（实测 `[PM2] 已加载 .env（2 个变量）`）
- **消息分片 / 限流重试 / 原子写**已实现并单测通过
- 云端配套：`src/keepalive.js`（返回 lastPush）、`ecosystem.config.cjs`（指数退避）、`.github/workflows/instabox-resume.yml`
- 部署文档：`CLOUD_DEPLOY.md`（真实额度、两道防线、pm2 startup、logrotate、告警、验收清单）
- `.env.example` 模板 + `.gitignore` 修正

### ⏳ 未完成 / 未验证

- **未实际部署到 InstaBox**（机器还没创建，控制台显示 0/1）
- **8 小时暂停后 ping 能否唤醒：未实测**（唯一需要时间验证的关键假设）
- UptimeRobot 账号未注册，监控未挂
- GitHub Actions 的 secrets（API key、machine id）未配置

---

## 6. 已知问题与技术债（必须让评估者看到）

### ✅ 已修复：pm2 不读 `.env`（原 P0，会让部署静默失败）

pm2 启动子进程时只继承当前 shell 的环境变量，**不会解析 `.env`**。
症状极具迷惑性：`pm2 list` 两个进程 online、日志有输出，但频道一条消息都没有，
`/ping` 永远 403（`KEEPALIVE_KEY` 也读不到），很容易误判成机器或网络问题。

修法（最终版）：`ecosystem.config.cjs` 检测到 `.env` 就传 `node_args: ['--env-file=.env']`，
让**应用自己**加载。三种方案对比：

| 方案 | 问题 |
|---|---|
| 在 ecosystem 里改 `process.env` | 只在 pm2 daemon 未运行时有效，`restart` / 开机自启后失效 |
| pm2 的 `env` 字段 | 可靠，但把**明文 token 写进 `~/.pm2/dump.pm2`** |
| **`node --env-file`（采用）** | 密钥不进 pm2，`kill`/`resurrect`/开机都重新读文件，Node 20.6+ 原生 |

启动日志出现 `[PM2] 找到 .env → 通过 node --env-file 加载`。

### ✅ 已修复：Telegram 上限 / 限流 / 状态非原子写

- **4096 字符上限**：会员版（行情 + 异动 + 6 条情报 + 深度解读）可能超限，超了 TG 返回 400，
  整条消息都发不出去。`splitForTelegram()` **按行累积切分**（每行都是完整单元，标签天然不跨片），
  单行超长时剥离标签再切（宁可丢链接也不让整条失败），片间 300ms。
  实测 7259 字符 → 2 片（3983 + 3275），标签零破损。
- **429 限流**：按 `retry_after` 等一次再重试（上限 60s，只重试一次，不死磕）。
- **state 非原子写**：`writeFileSync` 直接覆盖，写入瞬间被杀会让文件变空 →
  `readLastPush()` 返回 null → 下次启动立刻重复推。改成 tmp + `renameSync` 原子替换。
- **fetch 无超时**：`postTelegram` 原来没有 `AbortSignal`，网络抖动时连接可能挂几分钟 →
  `runOnce` 卡住 → `running` 锁永不释放 → 之后每轮 tick 都 `[SKIP]`，
  表现为「进程活着、日志在转、就是不推」。已加 `AbortSignal.timeout(20000)` + tick 层 5 分钟看门狗。

### ✅ 已修复：mcporter 路径写死 Windows（原 P0）

改为按平台判断，云端不会白试 Windows 路径，本地开发不受影响：

```js
const MCPORTER_CANDIDATES = [
  process.env.MCPORTER_CLI,
  path.join(__dirname, '..', 'node_modules', 'mcporter', 'dist', 'cli.js'),
  '/usr/local/lib/node_modules/mcporter/dist/cli.js',
  '/usr/lib/node_modules/mcporter/dist/cli.js',
  ...(process.platform === 'win32' ? ['C:\\Users\\...\\mcporter\\dist\\cli.js'] : []),
].filter(Boolean);
```

同时 `NO_MCPORTER` 从静默 `[SKIP]` 改为显式 `[WARN] mcporter 未安装 → 会员档缺「深度解读」模块`。

**仍未解决的部分**：云端到底装不装 mcporter、Exa 免费额度够不够跑 12 小时一次的搜索——**未验证**。

### 🟡 P1：会员档承诺的"空投观察"是空实现

`premium.js` 的 `airdropWatch()` 直接 `return []`（2026-10-09 主动停用，因为之前是"示例空投 A"占位内容，
公开频道出现这种会砸招牌）。**如果对外宣传会员含空投观察，属于画饼，必须修正宣传口径或接真数据源。**

### ✅ 已修复：常驻模式无自愈保护

改成惰性推送后，`setInterval` 只负责「每 5 分钟醒一次」，推送时机由 `state/schedule.json`
的时间戳决定。进程重启会读回时间戳，**不会重复推也不会丢推**。pm2 再叠加
`exp_backoff_restart_delay` 防止崩溃循环。

### 🟢 P2：状态文件无锁

`schedule.json` 已改成 tmp + rename 原子写。其余 `state/*.json`（源记忆、已读去重、热度榜）
仍是简单 `readFileSync/writeFileSync`，多进程并发写会互相覆盖。
当前只有一个 bot 进程，无实际风险；若将来多实例部署需换 SQLite 或加锁。

### 🟢 P2：源记忆是"粘性"的

一旦某源成功，后续优先用它。如果该源返回的数据质量下降（比如只返回部分币种），
不会自动切回更优的 tier 1 源。属于可用性 vs 质量的取舍。

---

## 7. 需要评估的核心问题（这是提问清单）

### Q1. 一台 4C8G 机器上跑多个项目，怎么组织？

用户的真实痛点是：**免费档只有 1 台 4 vCPU / 8 GiB**，但除了这个 bot，还有别的项目要跑
（AI agent 网关、任务类 agent 等）。需要评估：

- 这个 bot 实际资源占用多大？（它是 I/O 密集型，大部分时间在 sleep，内存约 60~100 MB）
- 多个 Node 进程 + 一个 Docker 环境共存，8 GiB 够不够？会不会 OOM？
- 隔离方案选哪个：pm2 多 app / Docker Compose / systemd unit？各自的运维成本和故障隔离性如何？
- 端口冲突怎么规划（每个项目都要开公网端口，只有 16 个额度）？

### Q2. 8 小时强制暂停：惰性推送已实现，还剩什么？

**已解决的部分**：惰性推送已落地——每 5 分钟自检，距上次成功推送不足间隔就不推。
即使机器被暂停 8 小时，**唤醒后 5 分钟内自动补推，不会丢内容**。
所以 8 小时上限现在只影响「内容延迟」，不再影响「内容丢失」。

**仍未解决 / 需要评估**：
- 机器被暂停期间，`/ping` 到底能不能把它唤醒？（官方文档只写了「闲置暂停」可被端口访问唤醒）
- 如果唤不醒，GitHub Actions 每 4 小时 resume 仍是最简方案——有没有更可靠的免费定时器
  能发带自定义 header 的 POST？（cron-job.org 无法动态生成 Idempotency-Key）
- 8 小时计时是「连续运行」还是「累计运行」？resume 后是否重置？（**未实测，部署后验证**）

### Q3. 免费档 vs 付费 VPS，什么时候该换？

- InstaBox 免费：0 元，但 1 台、8 小时上限、beta 无 SLA、官方明说"免费到我们想清楚为止"
- Oracle 免费机：0 元，4 核 24G 长期资产，但抢不到
- 低价 VPS：约 $5/月（≈36 元），无暂停限制
- 用户预算 500 元，月付 36 元意味着一年 432 元——**几乎吃掉全部启动资金**

需要判断：这个 bot 在什么用户量/收入水平下，值得从免费档迁移到付费 VPS？

### Q4. 这个产品本身值得继续投入吗？

诚实评估点：
- 加密行情推送是**极度红海**（Telegram 上同类频道数以千计，多数免费）
- 差异化只有"深度解读"和"异动榜"，但数据源都是公开的，壁垒极低
- 目标用户（中文加密散户）对付费 $9/月 的意愿存疑
- 目前 **0 用户、0 收入**，只有作者自己的私人号在收推送

请评估：这是不是一个应该继续投入的方向？如果不值得，什么样的相邻方向更值得？

---

## 8. 文件清单

```
crypto-bot/
├── src/
│   ├── bot.js            入口/编排/分档发送
│   ├── config.js         配置（env 优先）
│   ├── fetch.js          行情多源降级
│   ├── intel.js          新闻 RSS + Exa 深度解读
│   ├── premium.js        会员档数据
│   ├── format.js         Telegram HTML 格式化
│   ├── keepalive.js      云端保活端点
│   └── state.js          状态目录 + 上次推送时间戳
├── state/                运行时状态（gitignore）
│   ├── market-source.json   源记忆
│   ├── news-seen.json       已读新闻去重
│   └── trending.json        上轮热度榜
├── scripts/              诊断脚本
├── .github/workflows/instabox-resume.yml   云端续命
├── ecosystem.config.cjs  pm2 配置
├── .env.example          环境变量模板
├── config.example.json   配置模板
├── CLOUD_DEPLOY.md       云端部署 SOP
├── PROJECT_BRIEF.md      本文档（交给其他 AI 评估用）
└── package.json          无 dependencies，仅 scripts
```

---

## 9. 给评估者的一句话

**代码质量本身不是问题**（多源降级、容错、零依赖这些做得比多数同类项目扎实）。
真正的不确定性在**商业侧**：红海市场、零用户、免费云的环境限制、以及用户只有 500 元本金。
请优先评估 §7 的 Q1 和 Q4——技术怎么跑通只是时间问题，值不值得跑才是关键。
