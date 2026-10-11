# Chain Intel Bot · 链上情报 Bot

A self-hosted Telegram bot that aggregates crypto market data and news into a single
scheduled digest. Runs as plain Node.js — no framework, no paid API keys required.

Built for a simple purpose: if you want to run a paid crypto-intel channel, you need a
feed that (a) never goes fully dark when one data source dies, and (b) costs nothing to
operate. This is that feed.

## What it does

- **Market snapshot** — top 10 by market cap (stablecoins and tokenized products filtered
  out), 24h movers, trending, total market cap, BTC dominance. **Automatic multi-source
  failover:** seven sources tried in priority tiers, so the push still goes out when
  CoinGecko is unreachable.
- **📰 News digest** — headlines from four crypto outlets (Cointelegraph / Decrypt /
  The Block / Bitcoin Magazine), deduplicated, balanced (max 2 per source), and filtered
  to only items not seen in the previous run.
- **🔍 Deep reads** — semantic search (Exa) for current market analysis with concrete
  levels and flow data; the query adapts to whatever is trending.
- Assembles everything into one Telegram message and pushes it to your channel/chat.
- **Demo mode** — with no token configured, it prints to the console instead.

## Quick start

```bash
npm run dry        # print only, do not send — always test with this first
```

The first run takes 10–20s while it probes data sources; subsequent runs are faster.

Check which sources your network can actually reach:

```bash
node scripts/diagnose.mjs
```

## Setup

1. **Create a bot** — talk to `@BotFather` on Telegram, send `/newbot`, save the `botToken`.
2. **Get a chat id** — add the bot to a chat and message it, then look up your `chat_id`
   via `@userinfobot`. To post to a channel, add the bot as a channel admin and use
   `@channel_handle` as the `chatId`.
3. **Configure** — copy `config.example.json` to `config.json` and fill in `botToken`,
   `chatId`, and your USDC receive address.
4. **Run** — `./run.bat` (Node 24), or `node src/bot.js --once` for a single test push.

> `config.json` is gitignored on purpose. Never commit a real bot token.

## Free tier vs. member tier

Two targets in `config.json`:

| Field | Sends to | Content |
|---|---|---|
| `telegram.chatId` | public channel | market + 1 headline as a hook + member ad |
| `telegram.memberChatId` | member channel (optional) | market + member-only + full digest + 🔍 deep reads, no ads |

**If `memberChatId` is not set**, everything goes to `chatId` and no member ad appears —
advertising a channel that does not exist is worse than not advertising.

So you can roll out in two steps: open the public channel first to build an audience, then
add the private member channel once you have a first paying subscriber.

## Why multi-source failover

**The problem:** CoinGecko is frequently unreachable (DNS pollution / connection timeouts).
When it dies, the entire market block disappears. The first version only had CoinGecko +
CoinCap, and both failed — nothing but `[ERR] 行情: fetch failed`.

**The approach** (`src/fetch.js`): every section has multiple sources, tiered by quality,
raced within the same tier.

| Section | tier 1 (best) | tier 2 | tier 3 (fallback) |
|---|---|---|---|
| Top 10 by cap | CoinGecko, Coinlore, CoinPaprika | OKX, Gate.io, Binance vision, Binance, CoinCap | — |
| Trending | CoinGecko trending | 24h gainers (scan every USDT pair on Gate.io / Binance vision / OKX / Binance) | computed from top 10 |
| Global overview | CoinGecko, Coinlore, CoinPaprika | — | — |

### Measured: on some networks only 2 sources work

```
✅ Gate.io          api.gateio.ws/api/v4/spot/tickers      402ms
✅ Binance vision   data-api.binance.vision/api/v3/ticker  429ms
❌ CoinGecko / Coinlore / CoinPaprika / OKX / Binance / CoinCap / MEXC / Kraken / Coinbase
```

`data-api.binance.vision` is worth knowing: it is Binance's official public market endpoint
(no key needed) and **stays reachable even when `api.binance.com` is blocked**. Both domains
are kept in the code as backups for each other.

The global-overview block is optional. When all three of its sources are unreachable, the
push simply omits the market-cap / BTC-dominance lines instead of erroring — and its timeout
is 4s rather than 7s so no time is wasted waiting.

### Deliberate design choices

- **Try last-known-good source first, then race by tier.** The chosen source is cached in
  `state/market-source.json`, so warm starts need one request (a few hundred ms) instead of
  waiting out a 7s timeout on a dead source.
- **Do not wait for every source.** A dead source must not drag the whole run to timeout.
  When all fail, a negative cache suppresses retries for 30 minutes.
- **Aggregators over exchanges.** Exchange APIs do not give market-cap rankings, so tier 1
  is reserved for aggregators that have real rankings.
- **Do not pass gainers off as trending.** Trending only exists on CoinGecko; when it falls
  back to gainers the label changes to `🔥 涨幅榜` accordingly.

### Timing

```
cold start ~18s (probing) → warm start ~11.6s
```

Of which ~8s is the deep-read subprocess (a full Node process + MCP handshake + search);
market data itself is only 0.4–0.8s. Do not bother optimizing market fetch — it is not the
bottleneck.

To change sources, edit the relevant `*_SOURCES` array in `src/fetch.js` (one source per
line; `tier` sets priority) and verify with `node scripts/diagnose.mjs`.

## How news sources were chosen

`src/intel.js` follows the capability audit of
[Agent-Reach](https://github.com/Panniantong/Agent-Reach).

| Channel | Status | Used |
|---|---|---|
| RSS/Atom feeds | ✅ available | **yes** — 4 crypto outlets |
| Semantic web search (Exa) | ✅ unlocked | **yes** — deep-read section |
| Arbitrary web pages (Jina Reader) | ✅ available | **yes** — `readArticle()` |
| YouTube subtitles | ✅ available | no (see below) |
| Reddit | ❌ no zero-config path | **deliberately skipped** |
| Twitter/X | ❌ requires cookies | **deliberately skipped** |

### Why not YouTube subtitles

The subtitle channel works, but **this bot has no LLM**. An hour of subtitles cannot be
summarized, and pasting it raw into Telegram just produces an unreadable wall. Adding a
"thought leaders" section means first deciding which model does the summarization — a
separate concern.

### Why not Reddit / Twitter

Both require cookie-based login, and the upstream project itself warns about account
detection and bans. Trading an account for data is not worth it, so this module only uses
public sources that need no login.

> Agent-Reach positions itself as a capability layer — selection, installation, audit,
> routing — with reads performed by upstream tools. So this bot calls those upstream
> services directly (RSS, Jina Reader, Exa via MCP) rather than wrapping another CLI layer.

### Adding sources

Edit the `FEEDS` array at the top of `src/intel.js`, one source per line. `fetchNews()`
enforces "max 2 per source" to keep one prolific feed from dominating.

## Project layout

```
src/bot.js        entry point + scheduler
src/fetch.js      market data with multi-source failover
src/format.js     message assembly
src/intel.js      news + deep reads
src/premium.js    member-tier content
scripts/diagnose.mjs   probe which sources are reachable
config.example.json    template — copy to config.json
```

## Roadmap

- On-chain whale monitoring (today the "whale moves" signal is just ≥8% 24h change, **not
  real on-chain data**)
- Airdrop aggregation (`premium.js`'s `airdropWatch()` returns an empty array until a real
  source is wired up)
- Payment verification: auto-issue an invite link after USDC payment

> This MVP uses only free APIs and requires no paid keys.

## License

MIT
