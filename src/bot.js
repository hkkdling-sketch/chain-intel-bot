// 主程序：抓取 -> 格式化 -> 推送 Telegram（未配置 token 时仅打印）
import { fetchMarkets, fetchTrending, fetchGlobal } from './fetch.js';
import { fetchMovers, fetchNewTrending, airdropWatch } from './premium.js';
import { formatReport } from './format.js';
import { fetchFreshNews, formatIntel, fetchDeepDive, formatDeepDive } from './intel.js';
import { cfg } from './config.js';
import { minutesSinceLastPush, nextDuePushTime, readLastPush, writeLastPush } from './state.js';

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

// Telegram 单条消息上限 4096 字符。留余量到 4000。
// 会员版内容（行情 + 异动 + 6 条情报 + 深度解读）通常 1200~1800 字符，
// 但新闻标题一长就可能超 —— 超了 TG 直接返回 400，整条消息都发不出去。
const TG_MAX_CHARS = 4000;

// 按「行」切分：每条内容都是一整行（`  • <a ...>标题</a> — 源`），
// 所以按行累积天然保证 HTML 标签不会跨片。
//
// 之前按字符切 + 回退到 '<' 只能防「切在标签内部」，
// 防不住「切在 <a>标题</a> 中间」——那会产出「片1 未闭合 / 片2 孤立 </a>」，
// TG 直接返回 400 can't parse entities，两片全发不出去。
function splitForTelegram(text, max = TG_MAX_CHARS) {
  if (text.length <= max) return [text];

  const chunks = [];
  let cur = '';

  for (const line of text.split('\n')) {
    // 单行本身超长（真实数据不会发生：每条都是短条目，标题已截断）。
    // 硬切必然破坏 HTML 标签 → 含标签时先剥离成纯文本再切。
    // 宁可丢链接，也不能让整条消息因 parse error 发不出去。
    if (line.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      const hasTags = line.includes('<');
      const plain = hasTags ? line.replace(/<[^>]+>/g, '') : line;
      if (hasTags) {
        console.warn('[WARN] 单行超长且含 HTML，已剥离标签后切分（链接会丢失）:', line.slice(0, 40) + '…');
      }
      for (let i = 0; i < plain.length; i += max) chunks.push(plain.slice(i, i + max));
      continue;
    }

    const next = cur ? cur + '\n' + line : line;
    if (next.length > max) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
}

async function postTelegram(url, payload, timeoutMs = 20000) {
  // Node 原生 fetch 默认没有整体超时：网络抖动时连接可能挂几分钟甚至永久。
  // 一旦卡住 → runOnce 卡住 → running 锁永不释放 → 之后每轮 tick 都 [SKIP]，
  // 表现为「进程活着、日志在转、就是不推」，最难排查。
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
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
  const chunks = splitForTelegram(text);

  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i], parse_mode: 'HTML' };
    let r = await postTelegram(url, payload);

    // 429 限流：按 retry_after 等一次再重试（只重试一次，别死磕；上限 60s 防长时间阻塞）
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      const waitMs = Math.min(j?.parameters?.retry_after ?? 5, 60) * 1000;
      console.warn(`[WARN] Telegram 限流，${waitMs / 1000}s 后重试一次`);
      await new Promise((res) => setTimeout(res, waitMs));
      r = await postTelegram(url, payload);
    }

    if (!r.ok) throw new Error(`tg ${r.status} ${await r.text()}`);

    const tag = chunks.length > 1 ? ` [${i + 1}/${chunks.length}]` : '';
    console.log(`[OK] 已发送到 Telegram (${chatId})${tag}`);

    // 分片之间歇 300ms，避免连续请求触发限流
    if (i < chunks.length - 1) await new Promise((res) => setTimeout(res, 300));
  }
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
    // Exa 免费 MCP 有速率限制，撞上就抛错 → 这里吞掉，少一块内容而已。
    // 但「压根没装 mcporter」必须显式警告：那是会员档承诺的功能缺了一块，
    // 不能只留一行 [SKIP] 让人误以为只是限流（详见 PROJECT_BRIEF.md §6）。
    fetchDeepDive({ numResults: 2 }).catch((e) => {
      if (e.code === 'NO_MCPORTER') {
        console.warn('[WARN] mcporter 未安装 → 会员档缺「深度解读」模块');
      } else {
        console.error('[SKIP] 深度解读:', e.message);
      }
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
      return false;
    }
    if (isBroadcast(freeChatId)) {
      console.log('[INFO] chatId 指向频道且未配 memberChatId → 只发免费版（会员内容不发）');
    }
    try {
      await sendTelegram(body, freeChatId);
      return true;
    } catch (e) {
      console.error('[ERR] 发送:', e.message);
      return false;
    }
  }

  // 配了会员频道 → 分开发：
  //   公开频道 = 免费版（行情 + 1 条头条）+ 会员广告
  //   会员频道 = 完整版（不含广告，人家已经付过钱了）
  let sent = 0;
  try {
    if (freeBody) {
      await sendTelegram(freeBody + buildFooter(), freeChatId);
      sent++;
    }
  } catch (e) {
    console.error('[ERR] 发送(公开频道):', e.message);
  }

  try {
    if (fullBody) {
      await sendTelegram(fullBody, memberChatId);
      sent++;
    }
  } catch (e) {
    console.error('[ERR] 发送(会员频道):', e.message);
  }

  // 至少有一个频道发成功才算「本轮推过」，否则不写时间戳，下轮会重试
  return sent > 0;
}

const intervalMin = cfg?.scheduleMinutes ?? 360;
// 定点推送时刻（如 08:30 / 20:30）。配了就优先用它，否则退回间隔模式。
const PUSH_TIMES = cfg?.pushTimes ?? [];

// ── 惰性推送 ──────────────────────────────────────────────────────
// 不依赖「进程连续跑满 N 分钟」的 setInterval —— 云端机器会被强制暂停，
// 暂停期间定时器不推进，恢复后要么延迟、要么一醒来就补推一堆。
//
// 改成：每 5 分钟醒一次，问一句「距上次成功推送够间隔了吗」。
//   · 机器被暂停 8 小时 → 唤醒后 5 分钟内自动补推
//   · 进程重启 → 读 state 里的时间戳，不会重复推
//   · setInterval 漂移 → 完全无关了
const CHECK_EVERY_MS = 5 * 60 * 1000;
// 单轮最长 5 分钟：超了强制释放锁。防 fetch 挂起/数据源不返回导致
// running 永远为 true，之后每轮 tick 都 [SKIP]，惰性推送彻底停摆。
const WATCHDOG_MS = 5 * 60 * 1000;
let running = false;

async function tick(reason) {
  if (running) {
    console.log('[SKIP] 上一轮还没跑完');
    return;
  }

  // 两种调度模式：
  //   配了 PUSH_TIMES → 定点推送（到点才推；错过会补；推过不重复）
  //   没配 → 老逻辑：距上次成功推送够 scheduleMinutes 就推
  if (PUSH_TIMES.length) {
    const due = nextDuePushTime(new Date(), readLastPush(), PUSH_TIMES);
    if (!due) {
      console.log(`[SKIP] 未到推送时刻（${PUSH_TIMES.join(' / ')}），不推 (${reason})`);
      return;
    }
    const fmt = due.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`[INFO] 到点推送：${fmt} (${reason})`);
  } else {
    const gap = minutesSinceLastPush();
    if (gap < intervalMin) {
      console.log(`[SKIP] 距上次 ${gap.toFixed(0)} 分钟 < ${intervalMin}，不推 (${reason})`);
      return;
    }
  }

  running = true;
  const t0 = Date.now();

  const watchdog = setTimeout(() => {
    console.error('[FATAL] 本轮超过 5 分钟未结束，强制释放锁');
    running = false;
  }, WATCHDOG_MS);

  try {
    const ok = await runOnce();
    if (!ok) {
      console.error('[ERR] 本轮未发出任何内容，不记录时间，下轮重试');
      return;
    }
    if (DRY) {
      // 关键：--dry 绝不能写时间戳，否则本地试跑一次会让真机 12 小时不推
      console.log('[DRY] 试跑成功（不记录 lastPushedAt）');
    } else {
      writeLastPush();
    }
    console.log(`[OK] 推送完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error('[ERR] 本轮失败:', e.message);
  } finally {
    clearTimeout(watchdog);
    running = false;
  }
}

if (process.argv.includes('--once')) {
  // --once 是「立刻强制推一次」，不看间隔（手动补发用）
  const ok = await runOnce();
  if (ok && !DRY) writeLastPush();
} else {
  const modeDesc = PUSH_TIMES.length
    ? `定点推送 ${PUSH_TIMES.join(' / ')}`
    : `间隔 ${intervalMin} 分钟`;
  console.log(`链上情报 Bot 启动，${modeDesc}，每 5 分钟自检一次。Ctrl+C 退出。`);
  await tick('启动');
  setInterval(() => tick('自检'), CHECK_EVERY_MS);
}
