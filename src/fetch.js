// 数据抓取层：多源自动降级 + 记住上次可用的源
//
// 为什么要这么麻烦：CoinGecko 在国内经常连不上（DNS 污染 / 连接超时），
// 它一挂，整条推送就少一块。所以每个板块都配多个源，挨个试，谁通用谁。
//
// 试出来的结果记到 state/market-source.json，下次直接用 ——
// 否则每轮都要在连不上的源上白等一次超时（这机器上单次超时 7 秒，很贵）。
//
// 想手动看哪个源能通：node scripts/diagnose.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', 'state');
const stateFile = path.join(stateDir, 'market-source.json');

const TIMEOUT = 7000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; chain-intel-bot/0.1)' };

// 全部源都挂时，这段时间内不再重试（省掉每次 7 秒的空等）
const NEGATIVE_TTL = 30 * 60 * 1000;

// 交易所接口不提供市值排名，只能按这个固定名单取。
// 名单比 10 长是**故意的**：抓取时保留稳定币（它们确实在市值前列），
// 由展示层（format.js 的 isNoise）决定要不要显示 —— 过滤掉稳定币后还能凑够 10 个。
const MAJOR_SYMBOLS = [
  'BTC', 'ETH', 'USDT', 'BNB', 'SOL', 'XRP', 'USDC', 'ADA', 'DOGE', 'TRX',
  'LINK', 'AVAX', 'TON', 'DOT', 'LTC', 'BCH', 'HBAR', 'SUI', 'NEAR', 'APT',
];

const STABLE = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'usds']);
const pctOf = (v) => (Number.isFinite(v) ? v : 0);

async function fetchJSON(url, timeout = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } catch (e) {
    // 把底层原因带上，否则只有一句 "fetch failed"，没法判断是 DNS 还是超时
    const cause = e.cause?.code || e.cause?.message;
    throw new Error(cause ? `${e.message} (${cause})` : e.message);
  } finally {
    clearTimeout(t);
  }
}

// ── 源记忆 ─────────────────────────────────────────────────────────
// 结构：{ markets: {source, at}, trending: {source, at}, global: {source, at} }
// source 为 null 表示「上次所有源都失败」，配合 NEGATIVE_TTL 做负缓存。

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

const state = readState();

function remember(section, source) {
  state[section] = { source, at: Date.now() };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {}
}

// 并发赛跑：谁先返回有效数据用谁，不等其余的 ——
// 否则一个挂掉的源会把整轮拖到超时（7 秒 × N）。
function raceFirst(tasks) {
  return new Promise((resolve, reject) => {
    const errs = [];
    let pending = tasks.length;
    let settled = false;

    if (!pending) return reject(new Error('没有可用源'));

    const fail = () => {
      if (!settled && --pending === 0) {
        settled = true;
        reject(new Error(errs.join(' | ')));
      }
    };

    for (const t of tasks) {
      t.run()
        .then((d) => {
          if (d?.length) {
            if (!settled) {
              settled = true;
              resolve({ data: d, source: t.name });
            }
          } else {
            errs.push(`${t.name}: 空数据`);
            fail();
          }
        })
        .catch((e) => {
          errs.push(`${t.name}: ${e.message}`);
          fail();
        });
    }
  });
}

// 挑一个能用的源：
//   1. 上次成功的源单独先试 —— 热启动就靠这一步做到几百毫秒
//   2. 不通就按 tier 分批赛跑（tier 小的质量高：聚合源 > 交易所 > 兜底）
//      同层内并发，谁先成功用谁；上层全挂才轮到下层
//   3. 全挂 → 记负缓存，NEGATIVE_TTL 内不再重试
async function pickSource(section, sources) {
  const st = state[section];

  // 负缓存：上一轮全部源都失败，这轮直接跳过，不白等
  if (st && st.source === null) {
    const age = Date.now() - (st.at || 0);
    if (age < NEGATIVE_TTL) {
      const left = Math.ceil((NEGATIVE_TTL - age) / 60000);
      throw new Error(`上次全部源失败，${left} 分钟后重试`);
    }
  }

  const pref = st?.source ?? null;
  const errs = [];

  // 1. 上次成功的源优先
  const prefSrc = pref ? sources.find((s) => s.name === pref) : null;
  if (prefSrc) {
    try {
      const d = await prefSrc.run();
      if (d?.length) return d;
      errs.push(`${prefSrc.name}: 空数据`);
    } catch (e) {
      errs.push(`${prefSrc.name}: ${e.message}`);
    }
  }

  // 2. 按 tier 分批赛跑
  const tiers = [...new Set(sources.map((s) => s.tier ?? 0))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const group = sources.filter((s) => (s.tier ?? 0) === tier && s !== prefSrc);
    if (!group.length) continue;
    try {
      const { data, source } = await raceFirst(group);
      if (source !== pref) {
        remember(section, source);
        console.log(`[INFO] ${section} 主源 → ${source}`);
      }
      return data;
    } catch (e) {
      errs.push(e.message);
    }
  }

  // 3. 全挂：记负缓存（并刷新时间戳），NEGATIVE_TTL 内不再重试
  remember(section, null);
  console.log(`[WARN] ${section} 所有源都不通`);
  throw new Error(errs.join(' | '));
}

// 把「币种 -> 原始行情」映射成统一的数组
function fromPairs(map, extract) {
  return MAJOR_SYMBOLS.map((sym) => {
    const raw = map.get(sym);
    if (!raw) return null;
    const { price, pct } = extract(raw);
    if (!Number.isFinite(price)) return null;
    return {
      symbol: sym.toLowerCase(),
      current_price: price,
      price_change_percentage_24h: Number.isFinite(pct) ? pct : 0,
    };
  }).filter(Boolean);
}

// 币安系接口：官方域名 + 公共行情镜像。
// ⚠️ `data-api.binance.vision` 是币安官方的公开行情端点，**在 api.binance.com 被墙时仍可达**
// （2026-10-09 实测：官方域名超时，镜像 954ms 正常返回）。所以两个都留。
function binanceMarkets(base) {
  return async () => {
    const j = await fetchJSON(`${base}/api/v3/ticker/24hr`);
    const rows = Array.isArray(j) ? j : [];
    if (!rows.length) throw new Error('空数据');
    const map = new Map();
    for (const t of rows) {
      const s = String(t.symbol || '');
      if (s.endsWith('USDT')) map.set(s.slice(0, -4), t);
    }
    return fromPairs(map, (t) => ({
      price: parseFloat(t.lastPrice),
      pct: parseFloat(t.priceChangePercent),
    }));
  };
}

// ── 板块一：市值前 10 ───────────────────────────────────────────────
// 每个源统一输出：[{ symbol, current_price, price_change_percentage_24h }]
// 前三个是聚合源（带真实市值排名），后面是交易所（按 MAJOR_SYMBOLS 固定名单取）。

const MARKET_SOURCES = [
  {
    name: 'CoinGecko',
    tier: 1,
    async run() {
      // per_page 取 15 而不是 10：展示层会滤掉稳定币，多取几个才能凑够 10 行
      const j = await fetchJSON(
        'https://api.coingecko.com/api/v3/coins/markets' +
          '?vs_currency=usd&order=market_cap_desc&per_page=15&page=1&price_change_percentage=24h'
      );
      if (!Array.isArray(j) || !j.length) throw new Error('空数据');
      return j.map((c) => ({
        symbol: c.symbol,
        current_price: c.current_price,
        price_change_percentage_24h: c.price_change_percentage_24h,
      }));
    },
  },
  {
    name: 'Coinlore',
    tier: 1,
    async run() {
      const j = await fetchJSON('https://api.coinlore.net/api/tickers/?limit=15');
      const rows = j?.data || [];
      if (!rows.length) throw new Error('空数据');
      return rows.slice(0, 15).map((a) => ({
        symbol: a.symbol,
        current_price: parseFloat(a.price_usd),
        price_change_percentage_24h: parseFloat(a.percent_change_24h),
      }));
    },
  },
  {
    name: 'CoinPaprika',
    tier: 1,
    async run() {
      const j = await fetchJSON('https://api.coinpaprika.com/v1/tickers?limit=15');
      if (!Array.isArray(j) || !j.length) throw new Error('空数据');
      return j.map((c) => ({
        symbol: c.symbol,
        current_price: c.quotes?.USD?.price ?? NaN,
        price_change_percentage_24h: c.quotes?.USD?.percent_change_24h ?? NaN,
      }));
    },
  },
  {
    name: 'OKX',
    tier: 2,
    async run() {
      const j = await fetchJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
      const rows = j?.data || [];
      if (!rows.length) throw new Error('空数据');
      const map = new Map();
      for (const t of rows) {
        const [base, quote] = String(t.instId || '').split('-');
        if (quote === 'USDT') map.set(base, t);
      }
      return fromPairs(map, (t) => {
        const last = parseFloat(t.last);
        const open = parseFloat(t.open24h);
        return { price: last, pct: open ? ((last - open) / open) * 100 : NaN };
      });
    },
  },
  {
    name: 'Gate.io',
    tier: 2,
    async run() {
      const j = await fetchJSON('https://api.gateio.ws/api/v4/spot/tickers');
      const rows = Array.isArray(j) ? j : [];
      if (!rows.length) throw new Error('空数据');
      const map = new Map();
      for (const t of rows) {
        const [base, quote] = String(t.currency_pair || '').split('_');
        if (quote === 'USDT') map.set(base, t);
      }
      return fromPairs(map, (t) => ({
        price: parseFloat(t.last),
        pct: parseFloat(t.change_percentage),
      }));
    },
  },
  {
    name: 'Binance',
    tier: 2,
    run: binanceMarkets('https://api.binance.com'),
  },
  {
    name: 'Binance vision',
    tier: 2,
    run: binanceMarkets('https://data-api.binance.vision'),
  },
  {
    name: 'CoinCap',
    tier: 2,
    async run() {
      const j = await fetchJSON('https://api.coincap.io/v2/assets?limit=10');
      const rows = j?.data || [];
      if (!rows.length) throw new Error('空数据');
      return rows.slice(0, 10).map((a) => ({
        symbol: a.symbol,
        current_price: parseFloat(a.priceUsd),
        price_change_percentage_24h: parseFloat(a.changePercent24Hr),
      }));
    },
  },
];

// 同一次运行里 buildReport / fetchMovers / fetchTrending 都会要行情，
// 用「飞行中的 Promise」做缓存：并发调用共享同一次抓取，不重复请求。
let mktInflight = null;
let mktAt = 0;
let mktData = null;

export async function fetchMarkets() {
  if (mktData && Date.now() - mktAt < 30000) return mktData;
  if (mktInflight) return mktInflight;

  mktInflight = (async () => {
    const data = await pickSource('markets', MARKET_SOURCES);
    mktData = data;
    mktAt = Date.now();
    return data;
  })();

  try {
    return await mktInflight;
  } finally {
    mktInflight = null;
  }
}

// ── 全市场涨幅榜 ───────────────────────────────────────────────────
// 扫一遍所有 USDT 交易对，按 24h 涨幅排序。
// 比「从市值前 10 里挑涨幅最大的」动态得多，否则「新晋热点」天天是同一批币、等于没有。
const MIN_QUOTE_VOLUME = 1e7; // 1000 万 USDT，滤掉没人交易的僵尸币

// 币安系接口的涨幅榜取数（官方域名 + 公共镜像，理由同 binanceMarkets）
function binanceGainers(base) {
  return async () => {
    const j = await fetchJSON(`${base}/api/v3/ticker/24hr`);
    const rows = Array.isArray(j) ? j : [];
    return rows
      .map((t) => {
        const s = String(t.symbol || '');
        const usdt = s.endsWith('USDT');
        return {
          symbol: usdt ? s.slice(0, -4) : '',
          quote: usdt ? 'USDT' : '',
          pct: parseFloat(t.priceChangePercent),
          vol: parseFloat(t.quoteVolume),
        };
      })
      .filter((r) => r.quote === 'USDT' && Number.isFinite(r.pct) && r.vol >= MIN_QUOTE_VOLUME);
  };
}

const GAINER_SOURCES = [
  {
    name: 'Gate.io',
    async run() {
      const j = await fetchJSON('https://api.gateio.ws/api/v4/spot/tickers');
      const rows = Array.isArray(j) ? j : [];
      return rows
        .map((t) => {
          const [base, quote] = String(t.currency_pair || '').split('_');
          return { symbol: base, quote, pct: parseFloat(t.change_percentage), vol: parseFloat(t.quote_volume) };
        })
        .filter((r) => r.quote === 'USDT' && Number.isFinite(r.pct) && r.vol >= MIN_QUOTE_VOLUME);
    },
  },
  {
    name: 'Binance vision',
    run: binanceGainers('https://data-api.binance.vision'),
  },
  {
    name: 'OKX',
    async run() {
      const j = await fetchJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
      const rows = j?.data || [];
      return rows
        .map((t) => {
          const [base, quote] = String(t.instId || '').split('-');
          const last = parseFloat(t.last);
          const open = parseFloat(t.open24h);
          return {
            symbol: base,
            quote,
            pct: open ? ((last - open) / open) * 100 : NaN,
            vol: parseFloat(t.volCcy24h) * last, // OKX 给的是币数量，乘价格≈USDT 成交额
          };
        })
        .filter((r) => r.quote === 'USDT' && Number.isFinite(r.pct) && r.vol >= MIN_QUOTE_VOLUME);
    },
  },
  {
    name: 'Binance',
    run: binanceGainers('https://api.binance.com'),
  },
];

async function fetchGainers(n = 5) {
  try {
    const { data } = await raceFirst(GAINER_SOURCES);
    return data
      .sort((a, b) => b.pct - a.pct)
      .slice(0, n)
      .map((x) => x.symbol);
  } catch {
    return [];
  }
}

// ── 板块二：热度榜 ─────────────────────────────────────────────────
// 返回 { kind, symbols }：
//   kind='trending' → CoinGecko 真实热度榜
//   kind='gainers'  → 降级成全市场 24h 涨幅榜
// 两种榜单不是一回事，所以标签要分开，不能拿涨幅榜冒充热度榜。

const TRENDING_SOURCES = [
  {
    name: 'CoinGecko',
    tier: 1,
    async run() {
      const j = await fetchJSON('https://api.coingecko.com/api/v3/search/trending');
      const symbols = (j?.coins || []).map((c) => c.item?.symbol).filter(Boolean).slice(0, 5);
      if (!symbols.length) throw new Error('空数据');
      return [{ kind: 'trending', symbols }];
    },
  },
  {
    name: 'gainers',
    tier: 2,
    async run() {
      const symbols = await fetchGainers(5);
      if (!symbols.length) throw new Error('空数据');
      return [{ kind: 'gainers', symbols }];
    },
  },
  {
    name: 'top10',
    tier: 3,
    async run() {
      const markets = await fetchMarkets();
      const symbols = markets
        .filter((c) => !STABLE.has(String(c.symbol).toLowerCase()))
        .sort((a, b) => pctOf(b.price_change_percentage_24h) - pctOf(a.price_change_percentage_24h))
        .slice(0, 5)
        .map((c) => c.symbol.toUpperCase());
      if (!symbols.length) throw new Error('空数据');
      return [{ kind: 'gainers', symbols }];
    },
  },
];

let trendInflight = null;
let trendAt = 0;
let trendData = null;

export async function fetchTrending() {
  if (trendData && Date.now() - trendAt < 30000) return trendData;
  if (trendInflight) return trendInflight;

  trendInflight = (async () => {
    try {
      const [result] = await pickSource('trending', TRENDING_SOURCES);
      trendData = result;
      trendAt = Date.now();
      return result;
    } catch {
      return { kind: 'none', symbols: [] }; // 拿不到就整行跳过，不编造
    }
  })();

  try {
    return await trendInflight;
  } finally {
    trendInflight = null;
  }
}

// ── 板块三：全球总览 ───────────────────────────────────────────────
// 三个源给的是一模一样的三组数字，所以不分层，全部 tier 1 一起赛跑 ——
// 分层的话全不通时要等 7 秒 × 层数（实测从 14 秒降到 7 秒）。
//
// 而且这块是**可选内容**（拿不到就跳过那两行），所以超时只给 4 秒：
// 2026-10-09 实测境内网络下三个源全不通，给 7 秒就是每轮白等 7 秒。
const GLOBAL_TIMEOUT = 4000;

const GLOBAL_SOURCES = [
  {
    name: 'CoinGecko',
    tier: 1,
    async run() {
      const j = await fetchJSON('https://api.coingecko.com/api/v3/global', GLOBAL_TIMEOUT);
      if (!j?.data) throw new Error('空数据');
      return [j.data];
    },
  },
  {
    name: 'Coinlore',
    tier: 1,
    async run() {
      // Coinlore /api/global/ 返回单元素数组
      const j = await fetchJSON('https://api.coinlore.net/api/global/', GLOBAL_TIMEOUT);
      const g = Array.isArray(j) ? j[0] : j;
      if (!g?.total_mcap) throw new Error('空数据');
      return [
        {
          total_market_cap: { usd: parseFloat(g.total_mcap) },
          market_cap_change_percentage_24h: { usd: parseFloat(g.mcap_change) },
          market_cap_percentage: { btc: parseFloat(g.btc_d) },
        },
      ];
    },
  },
  {
    name: 'CoinPaprika',
    tier: 1,
    async run() {
      const j = await fetchJSON('https://api.coinpaprika.com/v1/global', GLOBAL_TIMEOUT);
      if (!j?.market_cap_usd) throw new Error('空数据');
      return [
        {
          total_market_cap: { usd: j.market_cap_usd },
          market_cap_change_percentage_24h: { usd: j.market_cap_change_24h },
          market_cap_percentage: { btc: j.bitcoin_dominance_percentage },
        },
      ];
    },
  },
];

export async function fetchGlobal() {
  try {
    const [data] = await pickSource('global', GLOBAL_SOURCES);
    return data;
  } catch {
    return null; // format 已兼容 null
  }
}
