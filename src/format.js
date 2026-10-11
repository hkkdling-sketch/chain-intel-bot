// 消息格式化层：把行情拼成 Telegram HTML 文本（比 Markdown 更稳，不会被地址里的字符搞崩）

// 24h 涨跌幅统一成数字，防止某个源返回 null / NaN 时打印出 "NaN%"
const pctOf = (v) => (Number.isFinite(v) ? v : 0);

// ── 展示层过滤 ─────────────────────────────────────────────────────
// 稳定币和代币化产品占「市值前 10」的行是纯噪音：
// 「USDT: $1.00 (🟢0.00%)」没有任何信息量，读者还会觉得这条推送很业余。
//
// 只影响显示，**不动数据源** —— 数据照旧抓（它们确实是市值前列），
// 只是不往推送里放。这样也不影响 fetch.js 的多源降级判断。
const STABLE = new Set([
  'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDS', 'BUSD', 'PYUSD',
  'USDD', 'USDP', 'GUSD', 'FRAX', 'USDF', 'RLUSD', 'USD1', 'USDX',
  'SUSD', 'MIM', 'LUSD', 'DOLA', 'UST', 'USTC',
]);

function isNoise(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return true;
  if (STABLE.has(s)) return true;
  // 代币化股票/基金带下划线（如 FIGR_HELOC），真实币种 ticker 不会有
  if (s.includes('_')) return true;
  return false;
}

export function formatReport({ markets, trending, global, now }) {
  const lines = [];
  lines.push(`🦞 <b>链上情报</b> · ${now}`);
  lines.push('');

  // 过滤后仍取 10 个；万一全被过滤掉（理论上不会），退回原始列表，别让整块空着
  const majors = markets.filter((c) => !isNoise(c.symbol)).slice(0, 10);
  const shown = majors.length ? majors : markets;

  lines.push(`🔹 <b>市值前 10</b>${majors.length ? '（不含稳定币）' : ''}`);
  for (const c of shown) {
    const ch = pctOf(c.price_change_percentage_24h);
    const arrow = ch >= 0 ? '🟢' : '🔴';
    lines.push(`  ${c.symbol.toUpperCase()}: $${fmt(c.current_price)} (${arrow}${ch.toFixed(2)}%)`);
  }

  // 热度榜取不到会降级成涨幅榜（标签跟着变）；两个都没有才整行跳过
  const trendSyms = (trending?.symbols || []).filter((s) => !isNoise(s));
  if (trendSyms.length) {
    const label = trending.kind === 'trending' ? '热度榜' : '涨幅榜';
    lines.push('');
    lines.push(`🔥 <b>${label}</b>: ${trendSyms.join(', ')}`);
  }

  if (global) {
    const mc = global.total_market_cap?.usd;
    const mcCh = pctOf(global.market_cap_change_percentage_24h?.usd);
    lines.push('');
    lines.push(
      `🌐 <b>总市值</b>: $${fmt(mc)} (24h ${mcCh >= 0 ? '🟢' : '🔴'}${mcCh.toFixed(2)}%)`
    );
    lines.push(`💱 <b>BTC 占比</b>: ${pctOf(global.market_cap_percentage?.btc).toFixed(1)}%`);
  }

  return lines.join('\n');
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
