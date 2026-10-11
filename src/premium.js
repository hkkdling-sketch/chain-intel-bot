// 付费档数据源：异动预警 / 新币热点 / 空投观察（免费源，无需 key）
// 说明：真实巨鲸链上监控 / 空投聚合需要额外 API key，这里先用行情异动 + 热点追踪做 MVP，
//      空投观察先用占位清单，后续可接真实数据源。
import { fetchMarkets, fetchTrending } from './fetch.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', 'state');
const trendingFile = path.join(stateDir, 'trending.json');

const pctOf = (v) => (Number.isFinite(v) ? v : 0);

async function readPrevTrending() {
  try {
    return JSON.parse(fs.readFileSync(trendingFile, 'utf8'));
  } catch {
    return [];
  }
}

async function saveTrending(arr) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(trendingFile, JSON.stringify(arr));
  } catch {}
}

// 巨鲸级异动：24h 涨跌超过阈值的币（代理"大钱在动"）
export async function fetchMovers(threshold = 8) {
  try {
    const markets = await fetchMarkets();
    return markets
      .filter((c) => Math.abs(pctOf(c.price_change_percentage_24h)) >= threshold)
      .sort(
        (a, b) => Math.abs(pctOf(b.price_change_percentage_24h)) - Math.abs(pctOf(a.price_change_percentage_24h))
      )
      .slice(0, 5)
      .map((c) => ({
        symbol: c.symbol.toUpperCase(),
        pct: pctOf(c.price_change_percentage_24h),
      }));
  } catch {
    return [];
  }
}

// 新晋热点：本轮榜单里上一轮没出现过的新币/新热点
export async function fetchNewTrending() {
  try {
    const { symbols: cur } = await fetchTrending();
    // 榜单拿不到时返回空数组，这时别写 state ——
    // 否则把空数组存下来，下次真拿到数据时会误判成「全是新的」
    if (!cur.length) return [];

    const prev = await readPrevTrending();
    const prevSet = new Set(prev);
    const news = cur.filter((s) => !prevSet.has(s));
    await saveTrending(cur);
    return news;
  } catch {
    return [];
  }
}

// 空投观察
//
// ⚠️ 2026-10-09：**暂时停用**。
// 之前返回的是「示例空投 A / 示例空投 B」这种占位内容，公开频道里出现
// 「示例空投 A(示例)」会直接砸招牌（币圈对「画饼」极其敏感）。
// 真实的空投聚合需要额外数据源，等接上了再把这里换成真数据。
export function airdropWatch() {
  return [];
}
