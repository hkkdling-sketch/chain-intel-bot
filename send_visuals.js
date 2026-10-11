// 把 visual-test 的三张视觉素材推到 Telegram（sendPhoto）。
// 用法：node send_visuals.js
// 单张单命令发，避免本机网络中途断流导致整批发失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = 'C:/Users/25675/WorkBuddy AI/2026-09-17-00-00-38/crypto-bot/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const TOKEN = cfg.telegram.botToken;
const CHAT = cfg.telegram.chatId;
const API = `https://api.telegram.org/bot${TOKEN}`;

// 图片目录（绝对路径，跨工作区）
const IMG_DIR = 'C:/Users/25675/WorkBuddy AI/2026-09-25-13-40-04/visual-test';

// 只挑本次新做的三张（v3）
const ITEMS = [
  ['02-主视觉-1200x675.png', '主视觉 1200×675 —— 频道宣传主图'],
  ['03-TG头图-1600x640.png', 'TG 频道头图 1600×640'],
  ['01-X头像-400.png', 'X 头像 400×400（2 倍图）'],
];

async function sendPhoto(file, caption) {
  const buf = fs.readFileSync(path.join(IMG_DIR, file));
  const fd = new FormData();
  fd.append('chat_id', CHAT);
  fd.append('caption', caption);
  fd.append('photo', new Blob([buf], { type: 'image/png' }), file);

  const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    console.error(`[ERR] ${file}  http=${r.status}  ${j.description || ''}`);
    return false;
  }
  console.log(`[OK] ${file}  (${Math.round(buf.length / 1024)} KB)`);
  return true;
}

async function main() {
  const only = process.argv[2]; // 可选：只发某一张
  const list = only ? ITEMS.filter(([f]) => f.includes(only)) : ITEMS;
  if (!list.length) {
    console.error('没有匹配的图片：' + only);
    process.exit(1);
  }
  let ok = 0;
  for (const [file, caption] of list) {
    if (await sendPhoto(file, caption)) ok++;
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`\n完成 ${ok}/${list.length}`);
}

main();
