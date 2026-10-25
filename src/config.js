// 统一配置入口：环境变量优先，回退 config.json。
// 本地照旧用 config.json（零感知），云端只给环境变量 —— 仓库里永远不出现真实 token。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const cfgPath = path.join(root, 'config.json');

let fileCfg = null;
try {
  if (fs.existsSync(cfgPath)) {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch (e) {
  console.warn('[CFG] config.json 解析失败，改用环境变量:', e.message);
}

const pick = (...vals) => vals.find((v) => v != null && v !== '');

export const cfg = {
  telegram: {
    botToken: pick(process.env.TG_BOT_TOKEN, fileCfg?.telegram?.botToken),
    chatId: pick(process.env.TG_CHAT_ID, fileCfg?.telegram?.chatId),
    memberChatId: pick(process.env.TG_MEMBER_CHAT_ID, fileCfg?.telegram?.memberChatId),
  },
  scheduleMinutes: Number(pick(process.env.SCHEDULE_MINUTES, fileCfg?.scheduleMinutes)) || 360,
  usdc: {
    receiveAddress: pick(process.env.USDC_RECEIVE_ADDRESS, fileCfg?.usdc?.receiveAddress),
    monthlyPriceUsd: Number(pick(process.env.USDC_MONTHLY_PRICE, fileCfg?.usdc?.monthlyPriceUsd)) || 9,
  },
};

// 启动自检：缺关键配置时明确说一声，避免云端静默跑成 DEMO 模式还傻等推送
const missing = [];
const token = cfg.telegram.botToken;
if (!token || String(token).includes('PASTE')) missing.push('TG_BOT_TOKEN');
if (!cfg.telegram.chatId) missing.push('TG_CHAT_ID');
if (missing.length) {
  console.warn(`[CFG] 缺少 ${missing.join('、')} → 将以 DEMO 模式运行（只打印不发送）`);
}
