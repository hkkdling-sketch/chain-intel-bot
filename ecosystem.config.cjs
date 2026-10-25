// pm2 守护配置：bot / keepalive 崩溃自动重启，指数退避防雪崩。
//
// ⚠️ pm2 不会自动读 .env，而「在 ecosystem 里改 process.env」只在 pm2 daemon
//    尚未运行时有效：pm2 restart 继承的是旧 daemon 环境，开机自启（systemd 起 daemon）
//    更是完全不读 .env → token 读不到 → 又变 DEMO 模式 → 频道静默停推。
//
// ✅ 所以改用 Node 原生的 --env-file，让**应用自己**加载：
//    · 密钥不进 ~/.pm2/dump.pm2（不用 pm2 的 env 字段，那个会把明文写进 dump）
//    · pm2 kill / resurrect / 开机自启 都会重新读文件，不会失效
//    · Node 20.6+ 原生支持，零依赖
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '.env');
const hasEnv = fs.existsSync(envPath);

if (hasEnv) {
  console.log('[PM2] 找到 .env → 通过 node --env-file 加载（密钥不进 pm2 dump）');
} else {
  console.warn('[PM2] ⚠️ 未找到 .env → 依赖 config.json 或当前 shell 环境变量');
}
//
// 用法：
//   npm i -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup systemd -u $(whoami) --hp $HOME   # ← 开机自启，这步不能省
//
// ⚠️ 关于「暂停/恢复」：官方文档说暂停会保留内存和进程、恢复后接着跑。
//    但「连续运行 8 小时后暂停」是控制台新规则，官方文档没写清是 pause 还是 stop。
//    若实际是 stop（进程全没），没配 pm2 startup 的话重启后 bot 根本不会跑 ——
//    所以 pm2 startup 必须配，不能靠假设。
//
// ⚠️ 云端记得在 .env 里设 STATE_DIR=/data/home/chain-intel-bot/state
//    （持久盘；系统盘 / 在机器停止后可能重置，状态放那儿会丢）
module.exports = {
  apps: [
    {
      name: 'chain-intel-bot',
      script: 'src/bot.js',
      cwd: __dirname,
      // 只有 .env 存在时才传 --env-file（本地用 config.json 模式时不传）
      ...(hasEnv ? { node_args: ['--env-file=.env'] } : {}),
      autorestart: true,
      max_restarts: 100,
      min_uptime: 60000,
      restart_delay: 5000,
      // 崩溃循环时指数退避（100ms 起逐次翻倍），避免配置写错时反复重启烧 CPU
      exp_backoff_restart_delay: 100,
      time: true,
    },
    {
      name: 'keepalive',
      script: 'src/keepalive.js',
      cwd: __dirname,
      ...(hasEnv ? { node_args: ['--env-file=.env'] } : {}),
      autorestart: true,
      max_restarts: 100,
      min_uptime: 60000,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      time: true,
    },
  ],
};
