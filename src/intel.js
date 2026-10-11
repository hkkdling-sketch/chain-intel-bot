// 情报层：加密媒体头条 + 文章深读
//
// 选型参考 Agent-Reach（https://github.com/Panniantong/Agent-Reach）的 doctor 结果：
//   ✅ RSS/Atom 订阅源   → Agent-Reach 用 feedparser，这里直接在 Node 里解析
//   ✅ 任意网页          → Agent-Reach 用 Jina Reader（curl https://r.jina.ai/URL），这里直接调
//   ❌ Reddit / Twitter  → Agent-Reach 明确标注「没有零配置路径，必须登录态」，且官方提醒有封号风险
//                          → 本模块刻意不接，不拿账号去换数据
//
// 设计原则：零 npm 依赖（只用 Node 内置 fetch）、单个源挂了不影响其他源、失败静默降级。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchTrending } from './fetch.js';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', 'state');
const seenFile = path.join(stateDir, 'news-seen.json');

// 只保留实测可用的源。CoinDesk 的 RSS 路径近年改过，可靠性差，暂不纳入。
const FEEDS = [
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed' },
];

const UA = 'Mozilla/5.0 (compatible; chain-intel-bot/0.1)';

async function fetchText(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// RSS 文本里带 CDATA、HTML 实体、内嵌标签，全部洗掉
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Telegram HTML 模式只需要转义这三个，多转会把标题搞花
export function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseFeed(xml, source) {
  const blocks =
    xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = pick(b, 'title');
    let link = pick(b, 'link');
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const dateStr = pick(b, 'pubDate') || pick(b, 'updated') || pick(b, 'published');
    if (title && link) out.push({ title, link, source, ts: Date.parse(dateStr) || 0 });
  }
  return out;
}

// 拉全部源，按时间排序、按链接去重
export async function fetchNews(limit = 5) {
  const settled = await Promise.allSettled(
    FEEDS.map((f) => fetchText(f.url).then((xml) => parseFeed(xml, f.name)))
  );
  const all = [];
  for (const r of settled) if (r.status === 'fulfilled') all.push(...r.value);
  if (!all.length) return [];

  // 来源平衡：每个源最多取 2 条。否则某个高产源（如 Bitcoin Magazine 视频流）会霸榜
  const PER_SOURCE = 2;
  const bySource = new Map();
  for (const it of all) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const balanced = [];
  for (const arr of bySource.values()) {
    arr.sort((a, b) => b.ts - a.ts);
    balanced.push(...arr.slice(0, PER_SOURCE));
  }

  balanced.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const uniq = [];
  for (const it of balanced) {
    const key = it.link.replace(/[?#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }
  return uniq.slice(0, limit);
}

function readSeen() {
  try {
    return JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveSeen(links) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify(links.slice(0, 300)));
  } catch {}
}

// 只挑「上一轮没见过」的，避免每次推送都是同几条
export async function fetchFreshNews(limit = 5) {
  const news = await fetchNews(limit * 4);
  if (!news.length) return [];
  const prev = new Set(readSeen());
  const fresh = news.filter((n) => !prev.has(n.link));
  saveSeen(news.map((n) => n.link));
  // 首次运行没有历史，fresh 会等于全部，正常
  return (fresh.length ? fresh : news).slice(0, limit);
}

// 深读：用 Jina Reader 把任意网页转成干净正文（Agent-Reach 的 web 渠道就是这条）
export async function readArticle(url, maxChars = 900) {
  const txt = await fetchText('https://r.jina.ai/' + url, 20000);
  return txt.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

// 拼 Telegram HTML：免费版给 1 条头条，会员版给全量
export function formatIntel(news, { full = true } = {}) {
  if (!news.length) return '';
  if (!full) {
    const n = news[0];
    return `📰 <b>头条</b>: ${esc(n.title)}`;
  }
  const lines = ['📰 <b>情报速递</b> <i>(加密媒体头条)</i>'];
  for (const n of news) {
    lines.push(`  • <a href="${n.link}">${esc(n.title)}</a> — ${esc(n.source)}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 深度解读：Agent-Reach 的 exa_search 渠道（Exa 语义搜索，走 mcporter）
// ⚠️ Exa 免费 MCP 有速率限制，撞上了会返回限流提示 → 本模块直接抛错，由上层降级跳过
// ─────────────────────────────────────────────────────────────

// mcporter 的 cli.js 位置：可用环境变量 MCPORTER_CLI 覆盖
const MCPORTER_CANDIDATES = [
  process.env.MCPORTER_CLI,
  path.join(__dirname, '..', 'node_modules', 'mcporter', 'dist', 'cli.js'),
  'C:\\Users\\25675\\.workbuddy-ai\\binaries\\node\\workspace\\node_modules\\mcporter\\dist\\cli.js',
].filter(Boolean);

function findMcporter() {
  for (const p of MCPORTER_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export function exaAvailable() {
  return findMcporter() !== null;
}

// 根据当前热度榜拼查询。Exa 官方建议「描述理想页面」而不是丢关键词
export function buildExaQuery(trending = []) {
  const focus = trending.slice(0, 2).filter(Boolean);
  const topic = focus.length
    ? `${focus.join(' and ')} and the broader crypto market`
    : 'bitcoin and the broader crypto market';
  return {
    query: `latest expert analysis of ${topic}: price action, key support and resistance levels, and macro drivers`,
    objective:
      'Find the most recent, data-rich analysis explaining what is moving crypto prices right now. Prefer pieces with specific numbers, price levels and flow data.',
  };
}

// 解析 mcporter 的纯文本输出（每条结果以 Title/URL/Published/Author/Highlights 成块，块间用 --- 分隔）
function parseExa(out) {
  const items = [];
  for (const block of out.split(/\n-{3,}\n/)) {
    const title = (block.match(/^Title:\s*(.+)$/m) || [])[1];
    const url = (block.match(/^URL:\s*(\S+)$/m) || [])[1];
    if (!title || !url) continue;
    const published = ((block.match(/^Published:\s*(.+)$/m) || [])[1] || '').trim();
    const hl = block.indexOf('Highlights:');
    let snippet = hl >= 0 ? block.slice(hl + 'Highlights:'.length) : '';
    snippet = snippet
      .replace(/^#+\s*/gm, '')
      .replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    items.push({
      title: title.trim(),
      url: url.trim(),
      published: /^N\/A$/i.test(published) ? '' : published,
      snippet,
    });
  }
  return items;
}

// timeout 别给太大：mcporter 要起一个完整 Node 子进程 + MCP 握手 + 搜索，
// 正常 5~8 秒；给 90 秒的话一旦 Exa 卡住，整条推送会被拖住一分半。
export async function exaSearch({ query, objective, numResults = 3, timeout = 30000 } = {}) {
  const cli = findMcporter();
  if (!cli) {
    const e = new Error('未找到 mcporter，跳过深度解读');
    e.code = 'NO_MCPORTER';
    throw e;
  }
  let stdout = '';
  try {
    ({ stdout } = await execFileP(
      process.execPath,
      [cli, 'call', 'exa.web_search_exa', `query=${query}`, `objective=${objective}`, `num-results=${numResults}`],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
    ));
  } catch (err) {
    // ⚠️ execFile 失败时，真正的报错在 err.stderr / err.stdout，
    //    err.message 只有「Command failed: <整条命令>」——看不到原因。
    //    之前就是漏了这一步，导致线上只看到一堆命令文本，查不出是限流还是超时。
    const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
    const code = err.code ?? '';

    if (/rate limit|too many requests|\b429\b/i.test(detail)) {
      const e = new Error('Exa 免费额度限流');
      e.code = 'RATE_LIMIT';
      throw e;
    }
    if (err.killed || code === 'ETIMEDOUT' || /timed?\s?out/i.test(detail)) {
      const e = new Error(`mcporter 超时（${timeout}ms）`);
      e.code = 'TIMEOUT';
      throw e;
    }
    const e = new Error(`mcporter 退出码 ${code || '?'}${detail ? '：' + detail.slice(0, 300) : ''}`);
    e.code = 'MCPORTER_FAIL';
    throw e;
  }

  // 限流提示有时走 stderr 有时走 stdout，两处都要查
  if (/rate limit/i.test(stdout)) {
    const e = new Error('Exa 免费额度限流');
    e.code = 'RATE_LIMIT';
    throw e;
  }
  const items = parseExa(stdout);
  if (!items.length) {
    const e = new Error('Exa 返回为空或格式不认识');
    e.code = 'EMPTY';
    throw e;
  }
  return items.slice(0, numResults);
}

// 一条龙：拿热度榜 → 拼查询 → 搜 → 返回条目。任何一步失败都抛错，由上层降级
export async function fetchDeepDive({ trending, numResults = 2 } = {}) {
  // fetchTrending() 现在返回 { kind, symbols }，取 symbols；
  // 榜单拿不到时退回默认话题（BTC + 大盘），别让深度解读整块消失
  const list = trending ?? (await fetchTrending().catch(() => ({ symbols: [] }))).symbols ?? [];
  const { query, objective } = buildExaQuery(list);
  return exaSearch({ query, objective, numResults });
}

export function formatDeepDive(items) {
  if (!items?.length) return '';
  const lines = ['🔍 <b>深度解读</b> <i>(Exa 语义搜索)</i>'];
  for (const it of items) {
    lines.push(`  • <a href="${it.url}">${esc(it.title)}</a>`);
    if (it.snippet) lines.push(`    <i>${esc(it.snippet.slice(0, 240))}…</i>`);
  }
  return lines.join('\n');
}
