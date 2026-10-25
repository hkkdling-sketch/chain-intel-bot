# 链上情报 Bot · InstaBox 云端部署 SOP

> 目标：Bot 7×24 在云端跑，关掉自己的电脑也照常推送。
> 最后核实：2026-10-25（依据 InstaBox 控制台 + 官方 Limits / Lifecycle 文档）

## 一、免费计划的真实额度

| 项目 | 免费计划 | 说明 |
|---|---|---|
| **机器数量** | **1 台** | 暂停/停止也占名额。网传「5 台」是付费工作区，别信 |
| 规格 | 4 vCPU / 8 GiB | 免费档唯一规格 |
| 系统盘 | 16 GiB（`/`） | 停止后可能重置，别放代码 |
| 持久盘 | 20 GiB（`/data`） | **home 就在 `/data/home`**，代码和状态都放这里 |
| 存储池 | 200 GB | 快照 + 机器文件共用，按小时计 |
| 快照 | 5 个 | |
| 模板 | **仅 `agent-browser`** | 已预装 Node 22 + npm + git + Docker + Claude Code，开箱即用 |
| 闲置暂停 | **30 分钟，固定改不了** | 付费才能调或关闭 |
| **运行上限** | **连续运行 8 小时后暂停** | 控制台文案，官方文档尚未同步 |
| 公网端口 | 16 个/台 | |
| API key | 20 个 | Agent 可调接口开关机 |
| 计费 | **不计费** | 官方原话 "Free until we figure it out" |

⚠️ 三个必须记住的：
1. **只有 1 台机器**，所以 Bot 和保活端点跑在同一台里，别想拆开
2. **连续跑 8 小时会被暂停**，这是硬限制，需要外部定时器续命（见第四节）
3. **代码和状态都放 `/data/home`**，别放 `/root` 或 `/opt`——系统盘不一定持久

## 二、推送机制：为什么不再用「12 小时定时」

旧做法是 `setInterval(runOnce, 12h)`，在会强制暂停的机器上是错的：

- 暂停期间定时器不推进，恢复后节奏被拉长（12h 变 20h）
- 进程重启后定时器归零，可能一天推好几次

现在改成**惰性推送**：每 5 分钟醒一次，问一句「该不该推」。

### 两种调度模式

**① 定点推送（推荐，配 `PUSH_TIMES`）**

```bash
PUSH_TIMES=08:30,20:30
```

到点才推，特性：
- 机器被暂停错过某个时刻 → 唤醒后 5 分钟内**自动补推**（只补最近一次，不会补发一堆）
- 已经推过的时刻不会重复推（进程重启也不怕）
- 落在中文用户活跃时段，而不是凌晨 3 点

**② 间隔推送（不配 `PUSH_TIMES` 时的老逻辑）**

距上次成功推送够 `SCHEDULE_MINUTES` 就推。问题是起始时间决定一切：
15:24 部署 → 下次 03:24（凌晨），等于白发。

```
每 5 分钟 tick ──> 读 state/schedule.json 里的 lastPushedAt
                     │
                     ├─ 定点模式：算出「已到点且未推」的时刻，没有就 SKIP
                     ├─ 间隔模式：不足 N 小时就 SKIP
                     └─ 该推 → runOnce() → 发成功才写 lastPushedAt
```

好处：
- 机器被暂停 8 小时 → 唤醒后 5 分钟内自动补推
- 进程重启 → 读到时间戳，不会重复推
- 数据源全挂没发出去 → **不写时间戳**，下一轮继续重试

## 三、两道防线：为什么还需要保活

```
                ┌─ 防线1：UptimeRobot 每5分钟 ping ──> 破「闲置30分钟」
外部定时器 ─────┤
                └─ 防线2：GitHub Actions 每4小时 resume ──> 破「运行8小时」
```

**防线 1（防闲置）**：官方文档明确写「访问公网端口 URL 会唤醒闲置暂停的机器」，
所以 UptimeRobot 的 ping 不只是保活，还能把已经睡着的机器戳醒。

**防线 2（防 8 小时上限）**：这条是新规则，文档没写清「访问端口能否唤醒」。
**先实测**（见第五节），唤不醒再启用 GitHub Actions 定时调 resume API。

## 四、部署步骤

> **最快路径**：拉完代码直接跑 `bash deploy.sh`。
> 脚本会检查 Node 版本、校验 `.env` 有没有漏填、自动设 `STATE_DIR`、启动 pm2、打印启动日志。
> 第一次跑会从模板创建 `.env` 然后退出，你 `nano .env` 填完再跑一次即可。
> 下面的手动步骤供排查时对照。

### 0. 进云端机器（本地终端跑）

```bash
npx instabox@latest sh
```

首次会让你在浏览器登录 InstaBox（用 Google 账号），授权后自动进入机器的 shell。

### 1. 创建机器

控制台点「+ 创建机器」，或本地终端跑：

```bash
npx instabox@latest sh
```

进 shell 后确认环境：

```bash
node -v && git --version && free -m && df -h /data
```

### 2. 拉代码到持久盘

```bash
mkdir -p /data/home && cd /data/home
git clone https://github.com/hkkdling-sketch/chain-intel-bot.git
cd chain-intel-bot
npm install --omit=dev
```

> 若 push/pull 被代理挡，用 Contents API 脚本：
> `C:\Users\25675\WorkBuddy AI\2026-10-11-22-16-49\push_contents.sh`

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env
```

必填：`TG_BOT_TOKEN`、`TG_CHAT_ID`、`KEEPALIVE_KEY`、`USDC_RECEIVE_ADDRESS`

**推荐**：`PUSH_TIMES=08:30,20:30`（定点推送，落在活跃时段；不配则按 `SCHEDULE_MINUTES` 间隔推）

**必改**：`STATE_DIR=/data/home/chain-intel-bot/state`
（不设的话状态写到系统盘，机器停止后源记忆和推送时间戳全丢）

- `KEEPALIVE_KEY` 用随机串：`openssl rand -hex 32`
- `.env` 不进仓库，放心写真值

> ✅ **`.env` 由 Node 原生的 `--env-file` 加载**（`ecosystem.config.cjs` 检测到 `.env` 就自动加上这个参数）。
>
> 为什么不用别的办法：
> - pm2 本身**不会**读 `.env`，只继承当前 shell 的环境变量
> - 在 ecosystem 里改 `process.env` 只在 pm2 daemon 未运行时有效，
>   **`restart` / 开机自启（systemd 起 daemon）后会失效** → token 读不到 → 静默变 DEMO 模式
> - 用 pm2 的 `env` 字段虽然可靠，但会把**明文 token 写进 `~/.pm2/dump.pm2`**
>
> `--env-file` 是应用自己读文件：密钥不进 pm2，`kill`/`resurrect`/开机都会重新读，永不失效。

### 4. pm2 守护 + 开机自启（这步不能省）

```bash
npm i -g pm2

pm2 start ecosystem.config.cjs
pm2 logs --lines 20
# ↑ 必须看到：[PM2] 找到 .env → 通过 node --env-file 加载
# ↑ 不能看到：[CFG] 缺少 TG_BOT_TOKEN（看到了就是 DEMO 模式，一条都发不出去）

pm2 save

# 开机自启：生成 systemd 单元
pm2 startup systemd -u $(whoami) --hp $HOME
# ↑ 会打印一条 sudo 命令，复制执行它

# 验证 systemd 单元存在
systemctl status pm2-$(whoami)
```

**如果 `pm2 startup` 报错**（microVM 可能没有完整 systemd），用 cron 兜底：

```bash
(crontab -l 2>/dev/null; echo '@reboot sleep 30 && pm2 resurrect') | crontab -
crontab -l   # 确认写进去了
```

**日志轮转**（防止日志撑满 20G 盘）：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
pm2 set pm2-logrotate:compress true
```

### 5. 开公网端口

控制台 → 机器 → 公网端口 → 开 `8080`，拿到形如 `https://xxx.instabox.sh` 的 URL。

**先自测**（在本地终端跑，不是机器里）：

```bash
curl "https://xxx.instabox.sh/ping?key=你的KEEPALIVE_KEY"
# 期望返回 JSON：
# {"ok":true,"service":"chain-intel-bot","lastPush":"2026-10-25T...","minutesSinceLastPush":0,...}
# lastPush 为 null = 还没推过（首次部署正常）
```

### 6. 挂 UptimeRobot（防线 1）

1. uptimerobot.com 注册（免费档够用）
2. Add New Monitor → **HTTP(s)**
3. URL：`https://xxx.instabox.sh/ping?key=你的KEEPALIVE_KEY`
4. Interval：**5 minutes**
5. **Alert Contacts 勾上邮箱** ← 机器挂了能收到信，否则停了三天你都不知道
6. 保存后 Run Check 一次，确认返回 200

### 7. 验收清单

```bash
# ① 两个进程都 online
pm2 list

# ② 惰性推送生效
pm2 logs chain-intel-bot --lines 20
# 应看到：[OK] 推送完成 / [SKIP] 距上次 XX 分钟 < 720

# ③ 重启不重复推（关键验收）
pm2 restart chain-intel-bot
pm2 logs chain-intel-bot --lines 5
# 应看到：[SKIP] 距上次 X 分钟 < 720，不推 (启动)

# ④ 状态持久化
cat /data/home/chain-intel-bot/state/schedule.json
# 应有 {"lastPushedAt":"2026-..."}

# ⑤ 端到端
curl "https://xxx.instabox.sh/ping?key=你的key"
# 返回 JSON，lastPush 有时间

# ⑥ 真发一条
node src/bot.js --once

# ⑦ 模拟开机（最容易翻车的一项）
pm2 kill && pm2 resurrect
pm2 logs chain-intel-bot --lines 5
# 不能出现 [CFG] 缺少 TG_BOT_TOKEN
```

- [ ] `pm2 list` 两个进程 online
- [ ] `state/schedule.json` 有 lastPushedAt
- [ ] 重启后日志显示 SKIP（没重复推）
- [ ] UptimeRobot Up + 邮箱告警已勾
- [ ] 关掉自己电脑，第二天频道有推送

## 五、8 小时上限：先实测，再决定

**实测方法**（部署完成后第二天看）：

1. 记下机器启动时间
2. 8 小时后看控制台状态是 Running 还是 Paused
3. 如果是 Paused，再等 5 分钟看 UptimeRobot 的 ping 有没有把它戳醒（状态回 Running）
   - **被戳醒** → 什么都不用做，UptimeRobot 一道防线够了
   - **戳不醒** → 启用下面的 GitHub Actions 续命

**续命方案：GitHub Actions 每 4 小时 resume**

仓库里已有现成 workflow：`.github/workflows/instabox-resume.yml`

只需两步：
1. GitHub 仓库 → Settings → Secrets and variables → Actions → 新建两个 secret：
   - `INSTABOX_API_KEY`：控制台「API密钥」页新建一个
   - `INSTABOX_MACHINE_ID`：控制台机器详情里的 `m_xxx` 开头的 ID
2. Actions 页面 → 选 `Instabox Resume` → Run workflow 手动测一次

> ⚠️ GitHub 的定时任务在仓库 60 天无提交后会自动停用，收到邮件提醒时点一下重新启用

**手动续命命令**（应急用）：

```bash
curl -X POST "https://api.instabox.sh/v1/machines/<机器ID>/resume" \
  -H "X-API-Key: <你的API_KEY>" \
  -H "Idempotency-Key: $(uuidgen)"
```

## 六、日常维护

```bash
# 更新代码
cd /data/home/chain-intel-bot && git pull && pm2 restart all

# 看日志
pm2 logs chain-intel-bot --lines 50

# 看推送状态
curl "https://xxx.instabox.sh/ping?key=xxx"
cat /data/home/chain-intel-bot/state/schedule.json

# 强制补推一次（不看间隔）
node src/bot.js --once
```

## 七、安全红线

1. **config.json / .env 永不进 git** —— 提交前 `git status` 自查
2. **公网端口只开 8080**，且 `KEEPALIVE_KEY` 必须是强随机串（`openssl rand -hex 32`）
3. **不放私钥 / 助记词**（USDC 收款地址可以放，那是公开的）
4. **botToken 怀疑泄露**：@BotFather → /mybots → API Token → Revoke
5. **别放生产数据**：beta 服务 + 免费期无承诺。真做大了迁 VPS，重跑这份 SOP 就行

## 八、故障排查

| 现象 | 先查 |
|---|---|
| 频道没推送 | `pm2 logs chain-intel-bot`；是不是 DEMO 模式（env 没读到） |
| 日志显示 SKIP 很久 | `cat state/schedule.json` 看 lastPushedAt；可能时间戳被误写 |
| 推送时间不对（如凌晨） | `grep PUSH_TIMES .env`；配了定点推送就会忽略 SCHEDULE_MINUTES |
| 重启后重复推 | 检查 STATE_DIR 是否指向了持久盘；重启后 state 丢 = 时间戳丢 |
| 机器 Paused 且 ping 唤不醒 | 上 GitHub Actions 续命（第五节） |
| UptimeRobot 403 | key 和 URL 不一致；机器重建后 URL 变了 |
| UptimeRobot 超时 | 机器没起来 / pm2 挂了，`npx instabox@latest sh` 进去看 |
| 重启后代码没了 | 代码没放 `/data/home`，被系统盘重置了 |
| 磁盘满 | `pm2 install pm2-logrotate`（第四节） |
| 会员档缺「深度解读」 | 日志有 `[WARN] mcporter 未安装` → 装 mcporter 或撤掉该卖点 |
