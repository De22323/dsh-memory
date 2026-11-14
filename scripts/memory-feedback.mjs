// memory-feedback.mjs -- 记忆系统的**传感器**：把我"没想起来 / 找得费劲 / 被他纠正"记下来。
//
// 为什么需要它（2026-10-06 定的）：负反馈的误差信号不能是"卡超了 20 字"，得是
// **该想起来的时候没想起来**。这个文件只**记录**，一个字都不自动改 ——
// 效应器（tools\memory-decay.mjs）以后照它调。没有它，闭环里就没有传感器。
//
// 用法：
//   node tools\memory-feedback.mjs add miss "他问'上次不是做过吗'，我没想起来那件事"
//   node tools\memory-feedback.mjs add slow "为了找那条约定，翻了 4 个文件"
//   node tools\memory-feedback.mjs add corrected "他纠正我：方案是 12-22 出，不是 12-12"
//   node tools\memory-feedback.mjs list 10
//   node tools\memory-feedback.mjs stats
//
// kind：miss（没想起来）｜slow（找得费劲）｜corrected（他纠正）｜other

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.MEM_HOME || path.resolve(import.meta.dirname, '..');
const FILE = path.join(HOME, 'runtime', 'memory-feedback.jsonl');
const KINDS = ['miss', 'slow', 'corrected', 'other'];
const LABEL = { miss: '没想起来', slow: '找得费劲', corrected: '被他纠正', other: '其他' };

const read = () => {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
};

const usage = () => {
  console.log('用法：');
  console.log('  node tools\\memory-feedback.mjs add <miss|slow|corrected|other> "一句话"');
  console.log('  node tools\\memory-feedback.mjs list [条数]');
  console.log('  node tools\\memory-feedback.mjs stats');
};

const args = process.argv.slice(2);
const cmd = args[0] || 'list';

if (cmd === 'add') {
  const kind = args[1];
  const note = args.slice(2).join(' ').trim();
  if (!KINDS.includes(kind) || !note) { usage(); process.exit(1); }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), kind, note }) + '\n', 'utf8');
  console.log(`记下了（${LABEL[kind]}）：${note}`);
  if (kind === 'miss' || kind === 'corrected') {
    console.log('（这条是强信号：下次周体检会优先看它。）');
  }
} else if (cmd === 'list') {
  const n = Number(args[1]) || 10;
  const rows = read();
  if (!rows.length) { console.log('还没有任何反馈记录。'); process.exit(0); }
  for (const r of rows.slice(-n)) {
    console.log(`${r.ts.slice(0, 16).replace('T', ' ')}  [${LABEL[r.kind] ?? r.kind}]  ${r.note}`);
  }
} else if (cmd === 'stats') {
  const rows = read();
  if (!rows.length) { console.log('还没有任何反馈记录（这本身是个信号：要么我从不失手，要么传感器没在用）。'); process.exit(0); }
  const by = {};
  for (const r of rows) by[r.kind] = (by[r.kind] ?? 0) + 1;
  const week = rows.filter((r) => Date.now() - Date.parse(r.ts) < 7 * 86400000).length;
  console.log(`共 ${rows.length} 条；近 7 天 ${week} 条`);
  for (const k of KINDS) if (by[k]) console.log(`  ${LABEL[k]}（${k}）  ${by[k]} 条`);
  const strong = rows.filter((r) => r.kind === 'miss' || r.kind === 'corrected').length;
  console.log(`  其中强信号（miss + corrected）${strong} 条`);
} else {
  usage();
  process.exit(1);
}
