// 主程序：抓取 -> 格式化 -> 推送 Telegram（未配置 token 时仅打印）
import { fetchMarkets, fetchTrending, fetchGlobal } from './fetch.js';
import { fetchMovers, fetchNewTrending, airdropWatch } from './premium.js';
import { formatReport } from './format.js';
import { fetchFreshNews, formatIntel, fetchDeepDive, formatDeepDive } from './intel.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const cfgPath = path.join(root, 'config.json');

const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;

// --dry：只打印不发送。改完代码先用它验证，别拿真频道当试验场
const DRY = process.argv.includes('--dry');

async function buildReport() {
  const [markets, trending, global] = await Promise.all([
    fetchMarkets(),
    fetchTrending(),
    fetchGlobal(),
  ]);
  return formatReport({
    markets,
    trending,
    global,
    now: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  });
}

async function sendTelegram(text, target) {
  const tg = cfg?.telegram;
  const chatId = target ?? tg?.chatId;
  if (DRY || !tg?.botToken || tg.botToken.includes('PASTE') || !chatId) {
    console.log(`[DEMO]${DRY ? ' (--dry 试跑)' : ''} 未发送，仅打印:\n` + text);
    return;
  }
  const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!r.ok) throw new Error('tg ' + r.status + ' ' + (await r.text()));
  console.log(`[OK] 已发送到 Telegram (${chatId})`);
}

// 判断一个 chatId 是不是「公开广播目标」（频道 / 群）。
// Telegram 的 ID 规则：正数 = 个人；负数(-100…) = 频道/超级群；@handle 也是频道/群。
// 用来防止「会员专享内容被误发到公开频道」。
function isBroadcast(id) {
  if (id == null) return false;
  const s = String(id).trim();
  return s.startsWith('@') || s.startsWith('-');
}

// 会员广告只在**真的配了会员频道**时才出现。
// 否则等于在公开频道里承诺一个不存在的地方 —— 币圈对「画饼」零容忍。
// 广告只贴在免费版末尾（会员频道里的人已经付过钱了，不用再推销）。
function buildFooter() {
  const u = cfg?.usdc;
  const tg = cfg?.telegram;
  if (!tg?.memberChatId) return '';
  if (!u?.receiveAddress || u.receiveAddress.includes('YOUR_')) return '';
  return (
    `\n\n💡 <b>会员 $${u.monthlyPriceUsd}/月</b> · 完整情报速递 + 🔍深度解读 + 异动榜` +
    ` · USDC 付到 <code>${u.receiveAddress}</code>，付完私聊开通`
  );
}

async function buildPremium() {
  const [movers, news, drops] = await Promise.all([
    fetchMovers(8),
    fetchNewTrending(),
    Promise.resolve(airdropWatch()),
  ]);

  const lines = ['💎 <b>会员专享</b>'];
  if (movers.length) {
    lines.push('🐋 <b>巨鲸级异动 (24h ±8%+)</b>');
    for (const m of movers) {
      lines.push(`  ${m.symbol}: ${m.pct >= 0 ? '🟢' : '🔴'}${m.pct.toFixed(2)}%`);
    }
  }
  if (news.length) {
    lines.push(`🆕 <b>新晋热点</b>: ${news.join(', ')}`);
  }
  if (drops.length) {
    lines.push('🪂 <b>空投观察</b>');
    for (const d of drops) {
      lines.push(`  ${d.name}(${d.tag}): ${d.tip}`);
    }
  }
  return lines.join('\n');
}

async function runOnce() {
  // 四路并行，各自兜底：任何一路挂了只降级、不炸整条推送
  const [text, premium, news, deep] = await Promise.all([
    buildReport().catch((e) => {
      console.error('[ERR] 行情:', e.message);
      return '';
    }),
    buildPremium().catch((e) => {
      console.error('[ERR] 会员档:', e.message);
      return '';
    }),
    fetchFreshNews(6).catch((e) => {
      console.error('[ERR] 情报:', e.message);
      return [];
    }),
    // Exa 免费 MCP 有速率限制，撞上就抛错 → 这里吞掉，少一块内容而已
    fetchDeepDive({ numResults: 2 }).catch((e) => {
      console.error('[SKIP] 深度解读:', e.message);
      return [];
    }),
  ]);

  const parts = [text];

  // 免费档：只给 1 条头条做钩子
  const teaser = formatIntel(news.slice(0, 1), { full: false });
  if (teaser) parts.push(teaser);

  // 会员档：行情 + 会员专享 + 完整情报速递 + 深度解读
  const memberParts = [text, premium, formatIntel(news, { full: true }), formatDeepDive(deep)].filter(
    Boolean
  );

  const memberChatId = cfg?.telegram?.memberChatId;
  const freeChatId = cfg?.telegram?.chatId;

  const freeBody = parts.filter(Boolean).join('\n\n');
  const fullBody = memberParts.join('\n\n');

  // 没配会员频道时，得先搞清楚 chatId 指向哪：
  //   私人号（自测）→ 发全部内容，方便你看完整效果
  //   公开频道     → **只能发免费版**，绝不能把「会员专享」白送出去
  // Telegram 的 ID 规则：正数 = 个人；负数(-100…) = 频道/群；@handle 也是频道/群。
  if (!memberChatId) {
    const body = isBroadcast(freeChatId) ? freeBody : fullBody;
    if (!body) {
      console.error('[ERR] 所有数据源都失败了，本轮跳过');
      return;
    }
    if (isBroadcast(freeChatId)) {
      console.log('[INFO] chatId 指向频道且未配 memberChatId → 只发免费版（会员内容不发）');
    }
    try {
      await sendTelegram(body, freeChatId);
    } catch (e) {
      console.error('[ERR] 发送:', e.message);
    }
    return;
  }

  // 配了会员频道 → 分开发：
  //   公开频道 = 免费版（行情 + 1 条头条）+ 会员广告
  //   会员频道 = 完整版（不含广告，人家已经付过钱了）
  try {
    if (freeBody) await sendTelegram(freeBody + buildFooter(), freeChatId);
  } catch (e) {
    console.error('[ERR] 发送(公开频道):', e.message);
  }

  try {
    if (fullBody) await sendTelegram(fullBody, memberChatId);
  } catch (e) {
    console.error('[ERR] 发送(会员频道):', e.message);
  }
}

const intervalMin = cfg?.scheduleMinutes ?? 360;

if (process.argv.includes('--once')) {
  await runOnce();
} else {
  console.log(`链上情报 Bot 启动，每 ${intervalMin} 分钟推送一次。Ctrl+C 退出。`);
  await runOnce();
  setInterval(runOnce, intervalMin * 60 * 1000);
}
