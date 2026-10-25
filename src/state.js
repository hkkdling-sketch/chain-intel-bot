// 状态目录 + 推送时间戳。所有 state 文件统一从这里取路径。
//
// 为什么单独抽出来：云端要把状态放持久盘（/data），而机器「停止」后系统盘可能重置。
// 如果只有 schedule.json 走 STATE_DIR、其余文件还写在项目目录，那等于没做持久化。
//
// 用法：
//   本地  → 默认 <项目>/state
//   云端  → .env 里设 STATE_DIR=/data/home/chain-intel-bot/state
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const stateDir = process.env.STATE_DIR || path.join(__dirname, '..', 'state');

const scheduleFile = path.join(stateDir, 'schedule.json');

export function readLastPush() {
  try {
    const j = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
    if (!j?.lastPushedAt) return null;
    const d = new Date(j.lastPushedAt);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function writeLastPush(d = new Date()) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    // 原子写：先写临时文件再 rename。
    // 直接 writeFileSync 覆盖时如果进程被杀（机器暂停/崩溃），文件可能变成空的，
    // 读回来 lastPushedAt 为 null → 下次启动会立刻重复推一条。
    const tmp = scheduleFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastPushedAt: d.toISOString() }, null, 2));
    fs.renameSync(tmp, scheduleFile);
  } catch (e) {
    // 写不进去不能让整轮推送失败 —— 最坏情况只是下一轮可能重复推
    console.warn('[STATE] 写入 lastPushedAt 失败:', e.message);
  }
}

// 距上次成功推送过了多少分钟。没有记录时返回 Infinity（= 立刻该推）
export function minutesSinceLastPush() {
  const last = readLastPush();
  return last ? (Date.now() - last.getTime()) / 60000 : Infinity;
}

// ── 定点推送 ────────────────────────────────────────────────────
// 给定当前时间、上次推送时间、目标时刻列表（如 ['08:30','20:30']），
// 返回「最近一个已经到点、但还没推过」的时刻；没有则返回 null。
//
// 为什么这样设计（而不是 setInterval 到点触发）：
//   · 机器被强制暂停 8 小时 → 唤醒后 5 分钟内自动补推，不会漏
//   · 只补最近一次，不会因为错过好几天就补发一堆
//   · 已经推过就返回 null，进程重启也不会重复推
//
// 只检查「今天」和「昨天」两个实例，够覆盖暂停/跨夜场景。
export function nextDuePushTime(now, last, times) {
  if (!times?.length) return null;
  let due = null;

  for (const t of times) {
    const [h, m] = String(t).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;

    for (const off of [0, -1]) {
      const target = new Date(now);
      target.setDate(target.getDate() + off);
      target.setHours(h, m, 0, 0);

      // 已经到点 且 上次推送早于该时刻 → 该推
      if (now >= target && (!last || last < target)) {
        if (!due || target > due) due = target;
      }
    }
  }
  return due;
}
