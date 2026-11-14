// memory-boxes.mjs -- 盒子结算：按时间把记忆往深里推一档。
//
// 规则（2026-11-08 定 · 2026-11-11 深夜改成"盒子是唯一真相"）：
//   0 新卡（建了不到 7 天）/ 1 浅（≤S 天没碰）/ 2 中（≤3S）/ 3 深（≤9S）/ 4 沉底（更久）
//   只升不降 —— 降只能靠翻卡（memory_get → planTouch 会把 box 减一档，深层有门槛）。
//   **state 只是 box 的投影**（L1/warm/cold），这里顺手同步，别让两套数据各说各话。
//
// 用法：node tools\memory-boxes.mjs [--dry]
// 建议：每天跑一次（收尾那条 memory-decay 旁边）。

import fs from 'node:fs';
import path from 'node:path';
import { HOME, generate, liveLeaves, readLeaves } from './memory-tree.mjs';
import { planBoxRise, stateOfBox } from './lib/memory-card.mjs';

const LEAVES = process.env.MEM_LEAVES || path.join(HOME, 'memory', '记忆', '条目.jsonl');
const dry = process.argv.includes('--dry');
const LABEL = ['新卡', '浅层', '中层', '深层', '沉底'];

const entries = readLeaves(LEAVES);
const now = Date.now();
const moves = [];
const dist = [0, 0, 0, 0, 0];
let stateSync = 0;

const out = entries.map((e) => {
  const cur = Math.max(0, Math.min(4, Number(e.box) || 0));
  const want = planBoxRise(e, now);
  if (want !== cur) moves.push({ id: e.id, title: e.title || String(e.content).slice(0, 12), from: cur, to: want });
  dist[want]++;
  if (e.state === 'pinned') return want === cur ? e : { ...e, box: want };
  const st = stateOfBox(want);
  const stChanged = e.state !== st;
  if (stChanged) stateSync++;
  if (want === cur && !stChanged) return e;
  return { ...e, box: want, state: st };
});

console.log(`条目 ${entries.length} ｜ 本次升盒 ${moves.length} 条 ｜ state 投影校正 ${stateSync} 条`);
console.log(`结算后分布：${dist.map((n, i) => `${LABEL[i]} ${n}`).join(' ｜ ')}`);
for (const m of moves.slice(0, 8)) console.log(`  ${m.id}  ${m.from}→${m.to}  ${m.title}`);
if (moves.length > 8) console.log(`  …其余 ${moves.length - 8} 条`);

if (dry) { console.log('（dry：没写盘）'); process.exit(0); }
if (!moves.length && !stateSync) { console.log('没有要动的（幂等）'); process.exit(0); }

// 写前备份
const bakDir = path.join(HOME, 'memory', '归档-旧版本与记录', '写入备份');
fs.mkdirSync(bakDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
fs.copyFileSync(LEAVES, path.join(bakDir, `条目.jsonl.bak-boxes-${stamp}`));

fs.writeFileSync(LEAVES, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
const t = generate({ dry: false });
console.log(`已写盘；卡片盒：目录 ${t.dirChars} 字 / 沉底 ${t.boxes[4]} 条`);
