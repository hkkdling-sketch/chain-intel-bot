// 保活端点：专门给外部监控服务（UptimeRobot / cron-job.org）每 5 分钟 ping 一次。
//
// 为什么需要：InstaBox 免费档「闲置 30 分钟强制休眠」是写死的（fixedAutoSuspendSeconds:1800，
// 官方文档改不了），休眠期间 setInterval 推送也会跟着停。
// 解法：在机器上开一个公网端口，让外部服务高频 ping，把机器一直维持在运行态。
//
// 安全设计：
//   /healthz  无密钥，只返回运行状态，可公开
//   /ping     必须带 ?key=<KEEPALIVE_KEY>；KEEPALIVE_KEY 未设置时一律 403
//             （公网端口 = 谁都能访问你的服务，这个 key 是唯一门闩，别用弱值）
//             返回 JSON 含 lastPush：既能保活，又能一眼看出「上次到底推没推」
import http from 'node:http';
import { readLastPush, minutesSinceLastPush } from './state.js';

const PORT = Number(process.env.KEEPALIVE_PORT) || 8080;
const KEY = process.env.KEEPALIVE_KEY || '';
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'chain-intel-bot',
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      })
    );
    return;
  }

  if (u.pathname === '/ping') {
    if (!KEY) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('KEEPALIVE_KEY not set');
      return;
    }
    if (u.searchParams.get('key') !== KEY) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('bad key');
      return;
    }
    // 回 JSON 而不是 "pong"：UptimeRobot 只看 200，但人肉排查时能直接看到
    // 「上次推送是什么时候、过去多久了」——比翻 pm2 日志快得多
    const last = readLastPush();
    const gap = minutesSinceLastPush();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'chain-intel-bot',
        lastPush: last ? last.toISOString() : null,
        minutesSinceLastPush: Number.isFinite(gap) ? Math.round(gap) : null,
        now: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[KEEPALIVE] 健康检查端点监听 :${PORT}`);
  console.log(`[KEEPALIVE] 对外 ping 地址：https://<你的InstaBox域名>/ping?key=${KEY ? '***已配置***' : '未配置(403)'}`);
});
