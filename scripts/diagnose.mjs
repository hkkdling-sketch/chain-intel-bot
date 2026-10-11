// 数据源连通性诊断
//
// 用途：行情抓不到时，跑这个查出到底是哪个环节断了。
// 用法：node scripts/diagnose.mjs
//
// 它会按「板块」分组测试所有候选源，报告每个源的 HTTP 状态或失败原因
// （DNS / 超时 / 拒绝），最后告诉你每个板块实际能用哪些源。
//
// 说明：bot 本身已经会自动切源（见 src/fetch.js），这个脚本是给你「看清楚现状」用的，
//      不是修 bug 的必经步骤。

const TIMEOUT = 12000;

// 按板块分组，和 src/fetch.js 里的 *_SOURCES 一一对应
const GROUPS = [
  {
    section: '市值前 10',
    targets: [
      ['CoinGecko', 'https://api.coingecko.com/api/v3/ping'],
      ['Coinlore', 'https://api.coinlore.net/api/tickers/?limit=1'],
      ['CoinPaprika', 'https://api.coinpaprika.com/v1/tickers?limit=1'],
      ['OKX', 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT'],
      ['Gate.io', 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT'],
      ['Binance', 'https://api.binance.com/api/v3/ping'],
      ['Binance vision', 'https://data-api.binance.vision/api/v3/ping'],
      ['CoinCap', 'https://api.coincap.io/v2/assets?limit=1'],
    ],
  },
  {
    section: '涨幅榜（热度榜的降级替代）',
    targets: [
      ['Gate.io', 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT'],
      ['Binance vision', 'https://data-api.binance.vision/api/v3/ping'],
      ['OKX', 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT'],
      ['Binance', 'https://api.binance.com/api/v3/ping'],
    ],
  },
  {
    section: '全球总览（总市值 / BTC 占比）',
    targets: [
      ['CoinGecko', 'https://api.coingecko.com/api/v3/ping'],
      ['Coinlore', 'https://api.coinlore.net/api/global/'],
      ['CoinPaprika', 'https://api.coinpaprika.com/v1/global'],
    ],
  },
];

// 热度榜本身没有免费替代，只能靠 CoinGecko
const TRENDING_TARGET = ['CoinGecko 热度榜', 'https://api.coingecko.com/api/v3/search/trending'];

async function probe(name, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chain-intel-bot/0.1)' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { name, ok: false, tag: `HTTP ${r.status}`, ms, why: explain(r.status) };
    await r.text();
    return { name, ok: true, tag: 'OK', ms };
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message || '';
    return {
      name,
      ok: false,
      tag: e.name === 'TimeoutError' ? '超时' : '连接失败',
      ms: Date.now() - t0,
      why: explainCause(cause),
    };
  }
}

function explain(status) {
  if (status === 429) return '被限流，等几分钟再试，或换源';
  if (status === 403 || status === 451) return '地区封锁（被墙）';
  if (status === 401) return '需要 API key 了，这个源作废';
  if (status === 404) return '接口地址变了';
  if (status >= 500) return '对方服务器故障，稍后再试';
  return '';
}

function explainCause(code) {
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'DNS 解析不了 → 多半没开 VPN，或 DNS 被污染';
  if (/ECONNREFUSED/.test(code)) return '连接被拒绝 → 本地防火墙 / 代理拦截';
  if (/ECONNRESET/.test(code)) return '连接被重置 → 多半被中间设备掐断';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return '连接超时 → 网络不通，需要 VPN';
  if (/CERT|SSL|TLS/i.test(code)) return 'TLS 握手失败 → 代理中间人 / 系统证书问题';
  return code || '未知原因';
}

function line(r) {
  const mark = r.ok ? '✅' : '❌';
  const tail = r.why ? `  ← ${r.why}` : '';
  return `  ${mark} ${r.name.padEnd(16)} ${String(r.tag).padEnd(10)} ${String(r.ms + 'ms').padEnd(9)}${tail}`;
}

// 同名源在多个板块出现，只测一次
const cache = new Map();
function cachedProbe(name, url) {
  const key = name + '|' + url;
  if (!cache.has(key)) cache.set(key, probe(name, url));
  return cache.get(key);
}

console.log('数据源连通性诊断');
console.log('='.repeat(72));
console.log(`按板块逐个测试，每个最多等 ${TIMEOUT / 1000} 秒……\n`);

const results = new Map();
for (const g of GROUPS) {
  const rs = await Promise.all(g.targets.map(([n, u]) => cachedProbe(n, u)));
  results.set(g.section, rs);

  console.log(`【${g.section}】`);
  rs.forEach((r) => console.log(line(r)));
  const ok = rs.filter((r) => r.ok).map((r) => r.name);
  console.log(ok.length ? `  → 可用：${ok.join('、')}\n` : '  → ⚠️ 无可用源，这块内容不会出现在推送里\n');
}

// 热度榜单独测
const tr = await cachedProbe(...TRENDING_TARGET);
console.log('【热度榜（真实热度，CoinGecko 独有）】');
console.log(line(tr));
console.log(tr.ok ? '  → 可用\n' : '  → ⚠️ 拿不到，会自动降级成「🔥 涨幅榜」（标签会跟着变，不冒充）\n');

// ── 结论 ──
console.log('='.repeat(72));
const mktOk = results.get('市值前 10').filter((r) => r.ok).length;
const allOk = [...results.values()].flat().filter((r) => r.ok).length;

if (mktOk) {
  console.log('结论：行情没问题，bot 会自动用能通的那个源。');
  if (tr.ok) {
    console.log('      CoinGecko 也通 → 热度榜和总市值都是完整版。');
  } else {
    console.log('      CoinGecko 不通 → 热度榜会降级成涨幅榜，总览那两行会省略（都是正常的）。');
  }
} else if (allOk) {
  console.log('结论：市值前 10 的所有源都不通，但有别的源活着。把上面输出发我。');
} else {
  console.log('结论：所有源都不通 → 网络层面就不通，先开 VPN / 检查代理再跑一次。');
}

console.log('\n提示：bot 会把选中的源记在 state/market-source.json，所以第一次跑慢、之后快。');
console.log('      想强制重新选源，删掉那个文件即可。');
