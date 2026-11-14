// memory-sink.mjs -- "沉降"实用版（Stage 3 那个"忘"的一半，先用最可靠的形式做）。
//
// 干什么：把 memory\生长\状态.md 里**最老的历史节**整段搬到 memory\归档-旧版本与记录\状态-历史节.md，
// 状态.md 只留 YAML 头（含 unfinished）+ 最近 MAX_KEEP 节 + 白名单里的节。
//
// 为什么：状态.md 是开场必读三份之一，却只增不减 —— 2026-10-08 8.4KB → 10-11 21.9KB（三天 2.5 倍）。
// 开场每轮都替它付钱，而里面十之七八早就是"历史记录"了。
//
// 铁律：**只搬不删**。搬完做守恒校验：每一节的正文都必须能在新文件里原样找到。
// 什么时候跑：**每轮收尾顺手一条** `node tools\memory-sink.mjs --auto` —— 没到线它自己什么都不做。
//
// 用法：
//   node tools\memory-sink.mjs                 # dry：打印会搬哪几节、搬完各多大
//   node tools\memory-sink.mjs --apply         # 真搬（含没到线也搬，按下面的口径）
//   node tools\memory-sink.mjs --auto          # 只在"超过上限"时才搬（收尾纪律用这个）
//   node tools\memory-sink.mjs --max=8         # 改上限（默认保留最近 6 节）

import fs from 'node:fs';
import path from 'node:path';
import { writeManifest } from './lib/memory-manifest.mjs';

const HOME = process.env.MEM_HOME || path.resolve(import.meta.dirname, '..');
const STATE = path.join(HOME, 'memory', '生长', '状态.md');
const ARCH = path.join(HOME, 'memory', '归档-旧版本与记录', '状态-历史节.md');
const BAKDIR = path.join(HOME, 'memory', '归档-旧版本与记录');

const args = process.argv.slice(2);
const AUTO = args.includes('--auto');
const APPLY = args.includes('--apply') || AUTO;
const MAX_KEEP = Number((args.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 6;

// 白名单（可选）：`--keep=关键词1,关键词2` —— 标题含这些字的节永远留在状态.md。
// 默认**空**：纯按"最近 MAX_KEEP 节"来判定，旧的自己走（写死日期反而会挡住以后的沉降）。
const KEEP_ARG = (args.find((a) => a.startsWith('--keep=')) || '').split('=')[1] || '';
const KEEP_ALWAYS = KEEP_ARG ? KEEP_ARG.split(',') : [];

const text = fs.readFileSync(STATE, 'utf8');
const lines = text.split('\n');
const heads = [];
lines.forEach((l, i) => { if (l.startsWith('## ')) heads.push(i); });
if (!heads.length) { console.log('✖ 找不到节标题（## ...），不动'); process.exit(1); }

const preamble = lines.slice(0, heads[0]).join('\n').replace(/\s+$/, '');
const sections = heads.map((h, k) => ({
  head: lines[h],
  body: lines.slice(h, k + 1 < heads.length ? heads[k + 1] : lines.length).join('\n').replace(/\s+$/, ''),
}));

const lastN = sections.slice(-MAX_KEEP);
const keep = sections.filter((s) => lastN.includes(s) || KEEP_ALWAYS.some((k) => s.head.includes(k)));
const sink = sections.filter((s) => !keep.includes(s));

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

if (AUTO && !sink.length) {
  console.log(`【auto】没到线：正文 ${sections.length} 节 ≤ 上限 ${MAX_KEEP} 节 ⇒ 一个字节都不动。`);
  process.exit(0);
}

const newState = [preamble, ...keep.map((s) => s.body)].join('\n\n') + '\n';
const oldArch = fs.existsSync(ARCH) ? fs.readFileSync(ARCH, 'utf8').replace(/\s+$/, '') : '';
const headLine =
  '<!-- 由 tools\\memory-sink.mjs 从 生长\\状态.md 整段搬来（只搬不删）。新的搬进来就追加在后面。 -->';
const newArch =
  (oldArch ? oldArch + '\n\n' : '# 状态 · 历史节（沉降归档）\n\n' + headLine + '\n') +
  '\n\n' + `<!-- ${stamp} 这次搬了 ${sink.length} 节 -->\n\n` +
  sink.map((s) => s.body).join('\n\n') + '\n';

// 守恒校验：每节正文都得能在新文件里原样找到
const lost = sections.filter((s) => !(newState.includes(s.body) || newArch.includes(s.body)));

console.log(`【${AUTO ? 'auto' : APPLY ? 'apply' : 'dry'}】共 ${sections.length} 节 → 留下 ${keep.length} 节、搬走 ${sink.length} 节（上限 ${MAX_KEEP}）`);
for (const s of sink) console.log(`  搬走 → ${s.head.replace(/^## /, '').slice(0, 64)}`);
for (const s of keep) console.log(`  留下 · ${s.head.replace(/^## /, '').slice(0, 64)}`);
console.log(`\n状态.md：${text.length} → ${newState.length} 字符（-${text.length - newState.length}）`);
console.log(`历史节文件：${oldArch.length} → ${newArch.length} 字符`);
console.log(lost.length ? `✖ 守恒校验失败：${lost.length} 节找不到` : '✅ 守恒校验：每一节正文都能在新文件里原样找到');

if (lost.length) { console.log('（不动任何文件）'); process.exit(1); }
if (!APPLY) { console.log('\n（dry：没写盘）'); process.exit(0); }

fs.mkdirSync(BAKDIR, { recursive: true });
const bak = path.join(BAKDIR, `状态.md.bak-before-sink-${stamp}`);
const beforeArch = fs.existsSync(ARCH) ? fs.readFileSync(ARCH, 'utf8') : '';
const manifest = writeManifest({
  actor: 'memory-sink',
  action: 'sink',
  files: [
    { path: STATE, before: text, after: newState },
    { path: ARCH, before: beforeArch, after: newArch },
  ],
});
fs.copyFileSync(STATE, bak);
fs.writeFileSync(STATE, newState, 'utf8');
fs.writeFileSync(ARCH, newArch, 'utf8');
console.log(`\n已搬（收据 ${path.basename(manifest)}）。备份：${path.basename(bak)}`);
console.log(`复核：状态.md 读回 ${fs.readFileSync(STATE, 'utf8').length} 字符 ｜ 归档 ${fs.readFileSync(ARCH, 'utf8').length} 字符`);
