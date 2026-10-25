#!/usr/bin/env bash
# 链上情报 Bot · InstaBox 云端一键部署
#
# 用法（在云端机器里、项目目录下）：
#   bash deploy.sh
#
# 第一次跑会从模板创建 .env 然后退出，让你填配置；
# 填完再跑一次，才会真正启动。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

echo "════════════════════════════════════════"
echo " 链上情报 Bot · 云端部署"
echo " 目录: $ROOT"
echo "════════════════════════════════════════"

# ── 1. 环境检查 ─────────────────────────────────
echo ""
echo "【1/6】环境检查"
NODE_V=$(node -v 2>/dev/null || echo "none")
echo "  node: $NODE_V"
echo "  npm:  $(npm -v 2>/dev/null || echo none)"
echo "  git:  $(git --version 2>/dev/null || echo none)"

NODE_MAJOR=$(echo "$NODE_V" | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "  ❌ 需要 Node 20+（--env-file 依赖 20.6+）"
  exit 1
fi
echo "  ✅ Node 版本满足（需要 20.6+）"

# ── 2. 依赖 ─────────────────────────────────────
echo ""
echo "【2/6】依赖安装（本项目零运行时依赖，很快）"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2 || echo "  （无依赖，跳过）"

# ── 3. .env 检查 ────────────────────────────────
echo ""
echo "【3/6】配置检查"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  已从模板创建 .env"
  echo ""
  echo "  ⚠️  现在去填配置，然后重跑本脚本："
  echo "      nano .env"
  echo ""
  echo "  必填 4 项："
  echo "    TG_BOT_TOKEN          ← @BotFather 拿的 token"
  echo "    TG_CHAT_ID            ← 你的频道 @handle 或 -100 开头的 ID"
  echo "    KEEPALIVE_KEY         ← 随机串，终端跑 openssl rand -hex 32 生成"
  echo "    USDC_RECEIVE_ADDRESS  ← 你的收款地址"
  echo ""
  echo "  填完执行：bash deploy.sh"
  exit 1
fi

# 占位符检查
PLACEHOLDER=0
if grep -qE 'PASTE_YOUR_BOT_TOKEN' .env; then echo "  ❌ TG_BOT_TOKEN 还是占位符"; PLACEHOLDER=1; fi
if grep -qE '@your_public_channel' .env; then echo "  ❌ TG_CHAT_ID 还是占位符"; PLACEHOLDER=1; fi
if grep -qE '^KEEPALIVE_KEY=$' .env || ! grep -q '^KEEPALIVE_KEY=' .env; then echo "  ❌ KEEPALIVE_KEY 为空"; PLACEHOLDER=1; fi
if grep -qE '0xYOUR_USDC_ADDRESS_HERE' .env; then echo "  ❌ USDC_RECEIVE_ADDRESS 还是占位符"; PLACEHOLDER=1; fi

if [ "$PLACEHOLDER" = "1" ]; then
  echo ""
  echo "  编辑后重跑：nano .env && bash deploy.sh"
  exit 1
fi

# STATE_DIR 自动指向项目下的 state（持久盘内）
if ! grep -q '^STATE_DIR=' .env; then
  echo "STATE_DIR=$ROOT/state" >> .env
  echo "  已追加 STATE_DIR=$ROOT/state"
else
  CUR_STATE=$(grep '^STATE_DIR=' .env | head -1 | cut -d= -f2-)
  if [ -z "$CUR_STATE" ]; then
    sed -i "s|^STATE_DIR=.*|STATE_DIR=$ROOT/state|" .env
    echo "  已设置 STATE_DIR=$ROOT/state"
  else
    echo "  STATE_DIR=$CUR_STATE"
  fi
fi

mkdir -p "$ROOT/state"
echo "  ✅ 配置检查通过"

# ── 4. 启动 ─────────────────────────────────────
echo ""
echo "【4/6】pm2 启动"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "  安装 pm2..."
  npm i -g pm2 2>&1 | tail -2
fi

pm2 delete all >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs 2>&1 | tail -10
pm2 save >/dev/null 2>&1 && echo "  ✅ pm2 save 完成"

# ── 5. 日志检查 ─────────────────────────────────
echo ""
echo "【5/6】启动日志（关键检查）"
sleep 4
pm2 logs --lines 30 --nostream 2>/dev/null | tail -30 || true

echo ""
echo "  ── 必须满足 ──"
echo "  ✅ 出现 [PM2] 找到 .env → 通过 node --env-file 加载"
echo "  ✅ 出现 [OK] 推送完成 或 [SKIP] 距上次 ... 不推"
echo "  ❌ 不能出现 [CFG] 缺少 TG_BOT_TOKEN（出现=DEMO模式，一条都发不出去）"

# ── 6. 后续手动步骤 ─────────────────────────────
echo ""
echo "【6/6】剩下的手动步骤"
cat <<'TIP'

  ① 开机自启（复制它打印的那条 sudo 命令执行）：
       pm2 startup systemd -u $(whoami) --hp $HOME

  ② 到 InstaBox 控制台给这台机器开公网端口 8080，
     拿到形如 https://xxx.instabox.sh 的地址

  ③ 本地终端验证（不在机器里跑）：
       curl "https://xxx.instabox.sh/ping?key=你的KEEPALIVE_KEY"
     期望返回 JSON：{"ok":true,"lastPush":"...","minutesSinceLastPush":...}

  ④ 注册 uptimerobot.com → Add Monitor → HTTP(s)
     URL 填上面那个 ping 地址，间隔 5 分钟，勾上邮箱告警

  ⑤ 真发一条到频道：
       node src/bot.js --once

  ⑥ 模拟开机，验证配置不丢（最容易翻车的一项）：
       pm2 kill && pm2 resurrect && pm2 logs --lines 5
     不能出现 [CFG] 缺少 TG_BOT_TOKEN

TIP
echo "════════════════════════════════════════"
echo " 部署脚本执行完毕"
echo "════════════════════════════════════════"
