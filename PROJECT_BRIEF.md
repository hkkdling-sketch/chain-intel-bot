# 链上情报 Bot · 项目交接文档

> 给接手的 AI 或协作者。**自包含**，无需任何前置对话上下文。
> 最后更新：2026-10-25 22:20 ｜ 版本 `6493994` ｜ 状态：**已上线运行中**

---

## 0. 三行速览

- **是什么**：Telegram 中文加密行情/情报推送 bot，Node.js 零依赖，1569 行代码
- **现在**：已部署到 InstaBox 免费云，每天 08:30 / 20:30 自动推送，**0 用户、0 收入**
- **代码**：https://github.com/hkkdling-sketch/chain-intel-bot （公开仓库，分支 `main`）

---

## 1. 项目是什么

### 1.1 产品形态

一个 Telegram 频道，每天固定两次推送加密市场摘要。免费档是钩子，会员档收费。

| 档位 | 内容 | 目标 |
|---|---|---|
| **免费档**（公开频道） | 市值前 10 行情 + 热度/涨幅榜 + 总市值 + BTC 占比 + **1 条中文头条** | 拉新、维持活跃 |
| **会员档**（付费频道） | 全部免费内容 + 24h 异动榜 + 新晋热点 + 完整情报速递（4~6 条）+ 深度解读（Exa 语义搜索） | $9/月 USDC |

**核心定位**：卖的不是"信息"（到处都有），是"**省时间**"——每天两条、2 分钟看完、不用刷 50 个群。

### 1.2 分发规则（代码已实现）

- `chatId` 是**频道**（`@handle` 或 `-100…`）且未配 `memberChatId` → **只发免费版**（防止会员内容白送）
- `chatId` 是**私人号**（正数）→ 发全部内容（自测用）
- 配了 `memberChatId` → 免费版发公开频道 + 会员广告尾巴，完整版发会员频道

### 1.3 收款

USDC 直接收款（EVM 地址），**人工确认后手动拉人**。没有自动化支付验证，是 MVP 阶段的人工环节。

### 1.4 用户背景（影响技术选型的关键约束）

- 大专在校生，启动资金约 500 元，**预算极低，只能用免费资源**
- Windows 本地开发，云端 Linux（Debian 13）
- 手上**还有其他项目要跑**（AI agent 网关等），但免费云只有 1 台机器
- 英语可读写，目标受众是**中文**加密用户
- 抗拒"自己一条条手动私信"，接受 AI 代做外联
- 对安全敏感：botToken 曾明文暴露，现已改走环境变量

---

## 2. 当前运行状态（2026-10-25 22:00）

### 2.1 部署

| 项 | 值 |
|---|---|
| 平台 | InstaBox 免费档（Firecracker microVM，YC P26 团队 InsForge 产品） |
| 规格 | 4 vCPU / 8 GiB / 20 GiB 持久盘（`/data`） |
| 系统 | Debian 13 (trixie)，内核 6.18，Node **v22.23.3** |
| 代码路径 | `/data/home/chain-intel-bot`（持久盘内，系统盘可能重置） |
| 进程 | pm2：`chain-intel-bot` + `keepalive`，均 online，合计约 60 MB |
| 开机自启 | systemd `pm2-user` = **enabled**（已用 `pm2 kill && resurrect` 验证） |
| 公网端口 | 8080 → `/healthz`（无鉴权）、`/ping?key=***`（需密钥） |
| 外部监控 | UptimeRobot 每 5 分钟 GET `/ping`，邮箱告警已开 |
| 配置方式 | `.env` 由 `node --env-file` 加载（密钥不进 pm2 dump） |
| 月成本 | **0 元**（InstaBox 免费期 + UptimeRobot 免费档） |

### 2.2 推送节奏

```
PUSH_TIMES=08:30,20:30
2026-10-25 15:24  第 1 条（部署时手动 --once 验证）
2026-10-25 20:30  第 2 条（第一条定点推送）
之后每天 08:30 / 20:30
```

### 2.3 已验证 / 未验证

**已验证**：
- 端到端推送成功（`[OK] 已发送到 Telegram`）
- 重启不重复推（`[SKIP] 距上次 X 分钟`）
- `pm2 kill && pm2 resurrect` 后配置不丢
- 外部 `/ping` 返回 JSON 含 `lastPush`
- 定点推送 8 个场景单测通过（含暂停后补推、跨天补漏、推过不重复）

**未验证**：
- **8 小时强制暂停后，`/ping` 能否唤醒机器**（唯一需要时间验证的假设，2026-10-25 23:30 见分晓）
- mcporter / Exa 深度解读在云端是否可用（当前未安装，会员档缺这块）
- 会员档实际推送效果（未配 `memberChatId`）

---

## 3. 技术架构

### 3.1 运行时

- **Node.js >= 20.6**（`--env-file` 需要；实际用 22）
- **零 npm 运行时依赖**（package.json 无 dependencies）——刻意设计，降低部署复杂度
- 唯一外部二进制依赖：**mcporter**（仅深度解读用，可选，缺失时显式警告后跳过）

### 3.2 模块职责

| 文件 | 行数 | 职责 | 关键设计 |
|---|---|---|---|
| `src/bot.js` | ~330 | 入口编排 + 调度 + 发送 | 四路并行抓取；`runOnce` 返回是否真发出；4096 分片；429 重试；20s 超时；5 分钟看门狗 |
| `src/config.js` | ~70 | 配置读取 | 环境变量优先，回退 `config.json`；`PUSH_TIMES` 解析 |
| `src/state.js` | ~90 | 状态目录 + 时间戳 + 定点调度 | `STATE_DIR` 可指持久盘；原子写；`nextDuePushTime()` |
| `src/fetch.js` | ~550 | 行情层 | 8 个行情源 / 4 个涨幅源 / 3 个全球源；多源降级 + 源记忆 + 负缓存 + 同层赛跑 |
| `src/intel.js` | ~320 | 情报层 | 1 中文源 + 4 英文 RSS；Jina Reader；Exa 语义搜索（走 mcporter CLI） |
| `src/premium.js` | ~75 | 会员档数据 | 异动预警、新晋热点；**空投模块已停用**（`return []`） |
| `src/format.js` | ~70 | Telegram HTML 格式化 | 过滤稳定币与代币化股票（下划线 ticker） |
| `src/keepalive.js` | ~90 | 健康检查端点 | `/ping` 需 key；返回 `lastPush` 状态 |
| `ecosystem.config.cjs` | ~85 | pm2 配置 | 指数退避；`node --env-file` 加载；不误删他人进程 |
| `deploy.sh` | ~145 | 一键部署 | 环境检查、`.env` 校验、`chmod 600`、pm2 启动、日志检查 |
| `.github/workflows/instabox-resume.yml` | ~60 | 8 小时续命（备用） | 每 4 小时调 resume API，需 2 个 GitHub Secrets |

### 3.3 数据流

```
                ┌─ fetchMarkets()   8 源降级 / 源记忆 / 30s 缓存 ─┐
                ├─ fetchTrending()  3 源降级 → 热度榜 or 涨幅榜  ─┤
  bot.js ───────┼─ fetchGlobal()    3 源赛跑 / 4s 超时          ─┼─> format.js ─> 分片 ─> Telegram
  (runOnce)     ├─ fetchFreshNews() 1 中文 + 4 英文 RSS / 去重  ─┤
                └─ fetchDeepDive()  mcporter → Exa（可选）      ─┘
```

### 3.4 容错策略（本项目最扎实的部分）

1. **多源降级**：每个板块 2~8 个免费源，按 tier 分组，同层并发赛跑，谁先返回有效数据用谁
2. **源记忆**：上次成功的源记在 `state/market-source.json`，下轮优先试（热启动几百毫秒）
3. **负缓存**：全源失败时记时间戳，30 分钟内不重试（避免每轮白等 7 秒超时）
4. **板块级降级**：任何一块失败都不影响整条推送
5. **抓取去重**：同一次运行内 `fetchMarkets()` 用 in-flight Promise 缓存

### 3.5 数据源（全部免费、无需 API key）

**行情**：CoinGecko / Coinlore / CoinPaprika / OKX / Gate.io / Binance / `data-api.binance.vision`（境内可达）/ CoinCap
**中文新闻**：深潮 TechFlow RSS（`techflowpost.com/rss/v2/feed.xml?lang=zh-CN&type=all&topic=all&tag=all`，实测 50 条/次、分钟级更新）
**英文新闻**：Cointelegraph / Decrypt / The Block / Bitcoin Magazine
**深读**：`r.jina.ai`
**深度解读**：Exa 语义搜索（经 mcporter，有免费额度限制）

> 背景：用户在中国大陆，CoinGecko 官方域名常被 DNS 污染，所以降级层做得这么厚。

### 3.6 调度机制：惰性 + 定点（重要）

**不用 `setInterval(12h)`**——机器会被强制暂停，定时器不推进，恢复后节奏失控。

改成：**每 5 分钟 tick 一次，读 `state/schedule.json` 判断该不该推**。

```
每 5 分钟 tick ──> 读 lastPushedAt
                     ├─ 配了 PUSH_TIMES：算「已到点但未推」的时刻，没有就 SKIP
                     ├─ 没配：距上次不足 SCHEDULE_MINUTES 就 SKIP
                     └─ 该推 → runOnce() → 真发出才写 lastPushedAt
```

定点模式的三个性质（已单测）：
- 机器暂停错过某时刻 → 唤醒后 5 分钟内**自动补推**（只补最近一次）
- 已推过的时刻**不会重复推**（进程重启也一样）
- 跨天漏推会补最近一次，不会补发一堆

---

## 4. 部署与运维

### 4.1 部署

```bash
# 本地进云端机器
npx instabox@latest sh

# 云端
mkdir -p /data/home && cd /data/home
git clone https://github.com/hkkdling-sketch/chain-intel-bot.git
cd chain-intel-bot
bash deploy.sh          # 第一次会创建 .env 并退出
nano .env               # 填 TG_BOT_TOKEN / TG_CHAT_ID / KEEPALIVE_KEY / USDC_RECEIVE_ADDRESS / PUSH_TIMES
bash deploy.sh          # 第二次真正启动
```

`deploy.sh` 会：检查 Node 20.6+ → 校验 `.env` 占位符 → 自动设 `STATE_DIR` → `chmod 600 .env` → 只删本项目进程 → pm2 start + save → 打印日志与检查点。

### 4.2 日常运维

```bash
pm2 logs chain-intel-bot --lines 50        # 看日志
pm2 restart chain-intel-bot                # 重启
cd /data/home/chain-intel-bot && git pull && bash deploy.sh   # 更新代码
cat /data/home/chain-intel-bot/state/schedule.json            # 看上次推送时间
node src/bot.js --once                     # 强制补推一次（不看时刻）
```

### 4.3 免费档限制与两道防线

| 限制 | 应对 |
|---|---|
| 闲置 30 分钟暂停（固定不可改） | UptimeRobot 每 5 分钟 GET `/ping`（官方文档确认：访问公网端口可唤醒） |
| **连续运行 8 小时后暂停**（控制台文案，文档未同步） | 先实测；唤不醒则启用 `.github/workflows/instabox-resume.yml`（每 4 小时调 resume API） |
| 只有 1 台机器 | bot 和 keepalive 同机；后续其他项目要挤在同一台 |
| 免费期无承诺（"Free until we figure it out"） | 当红利期工具用，别押生产数据 |

---

## 5. 已完成 / 未完成

### ✅ 已完成

- 全部业务代码 + 本地 `--dry` 验证
- 云端部署上线，端到端推送成功
- 惰性推送 + 定点推送（08:30 / 20:30）
- 中文源接入（深潮），免费档头条优先中文
- 消息分片（4096）、429 重试、20s 超时、5 分钟看门狗
- 原子写状态、`STATE_DIR` 全链路、`--env-file` 配置加载
- 一键部署脚本 + 完整 SOP（`CLOUD_DEPLOY.md`）
- 外部监控（UptimeRobot）+ 开机自启
- X 每日运营清单（`X_DAILY.md`）

### ⏳ 未完成

- **8 小时暂停后能否被 ping 唤醒：未实测**
- 会员档未启用（无 `memberChatId`）
- mcporter / Exa 未在云端配置 → 深度解读缺失
- 空投观察模块是空实现
- **0 用户、0 收入**（核心问题，非技术）
- 频道用户名 `@mflsqb` 随机字母，搜不到（待改）

---

## 6. 已知问题与技术债

### 🟡 P1：会员档两个卖点是空的

- **深度解读**：依赖 mcporter + Exa，云端未装 → `[WARN] mcporter 未安装`
- **空投观察**：`premium.js` 的 `airdropWatch()` 直接 `return []`（2026-10-09 主动停用，避免"示例空投 A"占位内容砸招牌）

**如果对外宣传会员含这两块，属于画饼。** 要么补实现，要么改宣传口径。

### 🟡 P1：`@mflsqb` 无法被搜索

Telegram 频道只能通过搜索或链接进入。随机字母用户名 = 放弃搜索流量。改名后需同步 `TG_CHAT_ID`（云端 `.env` + 本地 `config.json`）。

### 🟢 P2：其余 state 文件仍非原子写

`schedule.json` 已原子化，但 `market-source.json` / `news-seen.json` / `trending.json` 仍是直接覆盖。单进程无风险，多实例需换 SQLite。

### 🟢 P2：源记忆是"粘性"的

某源成功后优先用它，即使它返回的数据质量下降也不会自动切回更优源。属于可用性 vs 质量的取舍。

### 🟢 P2：`--once` 与常驻调度可能打架

手动 `--once` 会写 `lastPushedAt`，但常驻进程的内存状态不变（它是每次读文件，所以实际无冲突）。已在 deploy.sh 提示"发完立刻 restart"。

---

## 7. 待决策问题（交给接手者判断）

### Q1. 0 用户怎么破？（最重要）

频道已上线、内容每天自动产出，但**没有一个真实读者**。已给的方向：
- 改可搜索的频道名/用户名
- X 每日发内容（不贴链接，先攒互动）
- 在加密群"答问题"而非"发广告"

**需要判断**：这套路径的预期产出是多少？有没有更高效但不违反"不手动私信"约束的做法？

### Q2. 8 小时暂停的最终方案

如果 `/ping` 唤不醒，GitHub Actions 每 4 小时 resume 是唯一方案。**有没有更可靠的免费定时器？**（cron-job.org 无法动态生成 `Idempotency-Key`，这是关键障碍）

### Q3. $9/月 定价是否站得住

满街免费频道，两个卖点还是空的。$3–5 更现实，或先免费冲 500 人。**需要判断定价策略。**

### Q4. 一台 4C8G 上多项目共存

用户还有其他项目（AI agent 网关等）。bot 本身 I/O 密集、约 60 MB，资源不是问题；真正冲突是**8 小时暂停会让同机所有项目一起睡**。需要判断哪些项目能容忍中断。

### Q5. 这个方向值不值得继续投入

诚实评估点：
- 加密行情推送是极度红海，中文市场稍空但用户付费意愿存疑
- 差异化（多源降级、深度解读）数据源都是公开的，壁垒低
- 目前 0 用户、0 收入

---

## 8. 关键设计决策记录（别重复讨论）

| 决策 | 选择 | 理由 |
|---|---|---|
| 依赖 | **零 npm 依赖** | 免费云 + 新手部署，依赖越少越不容易挂 |
| 行情 | **多源降级 + 源记忆** | 用户在大陆，CoinGecko 常被 DNS 污染 |
| 调度 | **惰性 tick，不用 setInterval** | 机器会被强制暂停，定时器不可靠 |
| 配置 | **`node --env-file`，不用 pm2 `env` 字段** | pm2 的 env 会把明文 token 写进 `~/.pm2/dump.pm2` |
| 分片 | **按行累积切分** | 每行是完整单元，HTML 标签天然不跨片；按字符切会切断 `<a>` |
| 状态 | **`STATE_DIR` 指向持久盘** | 系统盘 `/` 在机器停止后可能重置 |
| 新闻源 | **中文源优先做头条** | 受众是中文用户，英文标题等于白推 |
| 自动发帖 | **不做** | 交易所 KYC 账号 + 风控，封了无法申诉；agent 只负责写，人点发送 |

---

## 9. 文件清单

```
crypto-bot/
├── src/
│   ├── bot.js            入口 / 调度 / 发送（分片、重试、看门狗）
│   ├── config.js         配置（env 优先）
│   ├── state.js          状态目录 + 定点调度算法
│   ├── fetch.js          行情多源降级
│   ├── intel.js          新闻 RSS + Exa 深度解读
│   ├── premium.js        会员档数据
│   ├── format.js         Telegram HTML 格式化
│   └── keepalive.js      健康检查端点
├── state/                运行时状态（gitignore）
├── .github/workflows/instabox-resume.yml   8 小时续命（备用）
├── deploy.sh             一键部署
├── ecosystem.config.cjs  pm2 配置
├── .env.example          环境变量模板
├── CLOUD_DEPLOY.md       部署 SOP（含故障排查）
├── X_DAILY.md            X 每日运营清单
└── PROJECT_BRIEF.md      本文档
```

---

## 10. 给接手 AI 的一句话

**技术上已经收尾**：上线了、跑起来了、容错做了、部署脚本有了。剩下的是**运营和商业判断**——怎么让第一个人进来、定价多少、要不要继续投入。

请优先回答 §7 的 Q1 和 Q5，不要在代码质量上继续优化——**边际收益已经趋近于零**。
