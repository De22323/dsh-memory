// memory-add.mjs -- 宿主侧的记忆写入口（唯一真相 = memory\记忆\条目.jsonl）。
//
// 为什么单拎一个：QQ 侧有 qq_memo_add，宿主侧一直靠手改文件 —— 实测结果就是"宿主侧 0 条"。
// 触发器（2026-10-11 起）：**每轮收尾顺手挑 0~3 条**，口径写在 AGENTS.md 的「收尾」里。
//
// 用法：
//   node tools\memory-add.mjs "他决定把索引层冻结，等叶 > 200 条再上衰减"
//   node tools\memory-add.mjs "..." --kind fact --imp 4 --kw 索引层,衰减 --vis private
//   node tools\memory-add.mjs "..." --parent b-记忆机制     ← 显式挂枝（2026-10-11 加），不再靠猜
//   node tools\memory-add.mjs --dry "先看看会写成什么样"
//
// 写之前自问三条（总设计 §四）：
//   ① 这条以后会被"用上"吗？（不是"它发生过"）
//   ② 找不到它会不会真出事？
//   ③ 他明确让我记的 → 直接写。
// 不进这里：待办（→ memory\待办.md）、工作过程（→ 生长记录.md）。

import { appendLeaves, writeProjection } from './memory-index.mjs';

const VALUE_FLAGS = new Set(['--kind', '--imp', '--kw', '--vis', '--ref', '--side', '--parent', '--supersedes', '--how', '--evidence']);
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// 取代判定（2026-10-18，他选①）：默认开；--no-supersede 关掉；
// --supersedes <id> 显式指定取代谁（"更正"那种，比相似判定可靠）。
const noSupersede = args.includes('--no-supersede');
const supersedesArg = flag('--supersedes', '');

// 只有"要值"的 flag 才吃掉下一个参数；--dry 是开关，不能把正文吞了（初版就栽在这）。
const parts = [];
for (let i = 0; i < args.length; i += 1) {
  if (VALUE_FLAGS.has(args[i])) { i += 1; continue; }
  if (args[i] === '--dry') continue;
  parts.push(args[i]);
}
const text = parts.join(' ').trim();

if (!text) {
  console.error('用法：node tools\\memory-add.mjs "要记的一句话" [--kind fact] [--imp 3] [--vis private] [--kw a,b] [--parent b-某枝]');
  console.error('（--dry 只预览。待办别写这儿，去 memory\\待办.md。）');
  process.exit(1);
}

/** 没给 --kw 时，从句子里挑几个 2~8 字的片段当触发词（线索比正文值钱，设计 §一-4）。 */
function guessKw(t) {
  const words = String(t)
    .split(/[，。；、,;：:\s（）()「」“”"']+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && w.length <= 8);
  return (words.length ? words : [String(t).replace(/\s+/g, '').slice(0, 6)]).slice(0, 3);
}

const kwArg = flag('--kw', '');
const parentArg = String(flag('--parent', '')).trim();
const item = {
  text,
  kw: kwArg ? kwArg.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : guessKw(text),
  kind: flag('--kind', 'fact'),
  imp: Number(flag('--imp', 3)) || 3,
  visibility: flag('--vis', 'private') === 'public' ? 'public' : 'private',
  ref: flag('--ref', 'manual:host'),
  side: flag('--side', 'h') === 'q' ? 'q' : 'h',
  // 显式挂枝（2026-10-11 加）：以前枝名全靠 pickBranch 用 kw[0] 兜底猜，同主题会裂成好几个枝。
  parent: parentArg || undefined,
  // 证据链（2026-11-08）：这条是怎么来的 + 原文片段（引用他原话 / 文件行 / 命令输出）
  provenance: {
    how: String(flag('--how', 'told')).trim(),      // told(他说的) / observed(看到/跑出来的) / inferred(我推的) / file(文件里)
    evidence: String(flag('--evidence', '')).trim(),
    ref: String(flag('--ref', 'manual:host')),
  },
};

const { added, skipped, superseded } = appendLeaves([item], {
  dry,
  supersede: !noSupersede,
  supersedes: supersedesArg ? supersedesArg.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : [],
});
if (!added.length) {
  console.log(skipped ? '这条和条目流里已有的重复，跳过（一个字没写）。' : '什么都没写（正文为空？）。');
  process.exit(0);
}
if (dry) {
  console.log(`预览：${JSON.stringify(added[0], null, 1)}`);
  if (superseded.length) console.log(`将取代：${superseded.map((s) => `${s.id} → ${s.by}`).join('，')}`);
} else {
  await writeProjection({ log: console.log });
  console.log(`已写入 ${added[0].id}（${item.kind} / imp ${item.imp} / ${item.visibility}）｜parent ${added[0].parent}`);
  if (superseded.length) console.log(`取代旧条：${superseded.map((s) => `${s.id}（被 ${s.by} 取代）`).join('，')}`);
}
