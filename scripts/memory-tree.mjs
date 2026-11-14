// memory-tree.mjs -- 「目录 + 枝页 + 沉底」生成器（卡片盒的第 1、2、4 层）
//
// 思路（2026-11-08 定，抄自南竹0v0 的分层记忆 + Mnemosyne 的检索准入）：
//   第 1 层 memory\目录.md        —— 只有枝：条数 / 各盒数 / 最近日期
//   第 2 层 memory\枝\<枝名>.md   —— 该枝的**标题**，按盒子分段（浅 / 中 / 深）
//   第 3 层 memory_get <id>      —— 全文（一次一条，最贵）；翻一次 = 记一次 access
//   第 4 层 memory\沉底.md        —— box 4 的，一行一条标题，枝页里不再出现
//
// 盒子（box）：0 新卡 / 1 浅 / 2 中 / 3 深 / 4 沉底。由条目自身的 box 字段决定，
//   结算脚本 memory-boxes.mjs 负责按时间升级；memory_get 负责翻卡降级。
//
// 用法：node tools\memory-tree.mjs [--dry] [--show]
//   --dry    只算不写
//   --show   把目录打到 stdout
//   ⚠️ 别用 --print / --list：memory-index.mjs 里这两条没做 main guard，import 进来会抢着打印。

import fs from 'node:fs';
import path from 'node:path';

// ⚠️ 这里**故意不 import memory-index.mjs**：memory-index 会在 writeProjection 里动态 import 本文件，
//    静态互引会形成循环（顶层 await 卡死，2026-11-08 实测「unsettled top-level await」）。
export const HOME = process.env.MEM_HOME || path.dirname(import.meta.dirname);
const LEAVES = process.env.MEM_LEAVES || path.join(HOME, 'memory', '记忆', '条目.jsonl');

export const DIR_FILE = process.env.MEM_DIR || path.join(HOME, 'memory', '目录.md');
export const BRANCH_DIR = process.env.MEM_BRANCH_DIR || path.join(HOME, 'memory', '枝');
export const SUNK_FILE = process.env.MEM_SUNK || path.join(HOME, 'memory', '沉底.md');

const MAX_ROWS = Number(process.env.MEM_BRANCH_ROWS) || 30;
const BOX_LABEL = ['新卡', '浅层', '中层', '深层', '沉底'];

export function readLeaves(file = LEAVES) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function liveLeaves(leaves) {
  return leaves.filter((r) => r && !r.superseded_by && !r.valid_to);
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const dispWidth = (s) => [...String(s)].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispWidth(s)));
const dayOf = (e) => String(e.ts || e.created_at || '').slice(0, 10);

/** 条目 -> 标题（v3 之后优先用条目自带的 title；老条目才现场截） */
export function makeTitle(entry) {
  const content = typeof entry === 'string' ? entry : entry?.content;
  if (entry && typeof entry === 'object' && entry.title) return entry.title;
  let s = String(content || '')
    .replace(/\d{4}-\d{2}-\d{2}[ T]?[\d:]*/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(早上|上午|中午|下午|傍晚|晚上|深夜|夜里|凌晨|今天|昨天|刚才|晚|早)[\s,，:]?/, '')
    .trim();
  const seg = s.split(/[：:。；;（(]/)[0].trim();
  let t = seg.length >= 4 ? seg : s;
  t = t.replace(/^[：:，,。；;、～~—\-·\s]+/, '').replace(/\s+/g, ' ').trim();
  if (!t) t = String(content || '').slice(0, 15);
  if (t.length > 16) t = t.slice(0, 15) + '…';
  return t;
}

export function buildGroups(leaves) {
  const byBranch = new Map();
  for (const e of leaves) {
    const b = (Array.isArray(e.path) && e.path.length ? e.path.join('/') : e.parent) || 'b-未归类';
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(e);
  }
  const groups = [];
  for (const [branch, arr] of byBranch) {
    const by = [0, 1, 2, 3, 4].map(() => []);
    for (const e of arr) by[Math.max(0, Math.min(4, Number(e.box) || 0))].push(e);
    for (const list of by) list.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    groups.push({ branch, all: arr, by, latest: arr.map(dayOf).sort().at(-1) || '' });
  }
  groups.sort((a, b) => String(b.latest).localeCompare(String(a.latest)) || b.all.length - a.all.length);
  return groups;
}

export function renderDirectory(groups, total, now = new Date()) {
  const nameW = Math.max(10, ...groups.map((g) => dispWidth(g.branch))) + 2;
  const lines = [
    '# 记忆目录',
    '',
    `> 生成物，别手改。源 = memory\\记忆\\条目.jsonl ｜ 共 ${total} 条 / ${groups.length} 枝 ｜ 生成 ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
    '> 新卡/浅/中/深 = 盒子；越深越久没被翻过。用法：这页 → memory_tree <枝> 看标题 → memory_get 翻全文',
    '',
    `${pad('枝', nameW)}${pad('条数', 7)}${pad('新', 5)}${pad('浅', 5)}${pad('中', 5)}${pad('深', 5)}最近`,
  ];
  for (const g of groups) {
    lines.push(`${pad(g.branch, nameW)}${pad(g.all.length, 7)}${pad(g.by[0].length, 5)}${pad(g.by[1].length, 5)}${pad(g.by[2].length, 5)}${pad(g.by[3].length, 5)}${g.latest}`);
  }
  return lines.join('\n') + '\n';
}

function trustMark(e) {
  const t = Number(e?.trust) || 0;
  return t < 0 ? ' ⚠' : t > 0 ? ' ✓' : '';
}

function rowOf(e) {
  const opens = Math.max(0, (Array.isArray(e.access) ? e.access.length : 0) - 1);
  const mark = opens ? `翻 ${opens} 次` : (Number(e.box) > 0 ? '未翻过' : '新');
  return `- ${dayOf(e)}  ${makeTitle(e)}${trustMark(e)}  ｜ ${mark} ｜ \`${e.id}\``;
}

export function renderBranch(g) {
  const lines = [
    `# ${g.branch} · ${g.all.length} 条 · 最近 ${g.latest}`,
    '',
    '> 生成物，别手改。这里是**标题**；要正文用 memory_get <id>（翻一次 = 记一次 access）。',
  ];
  for (const box of [0, 1]) {
    const list = g.by[box];
    if (!list.length) continue;
    lines.push('', `## ${BOX_LABEL[box]}（${list.length}）`);
    for (const e of list.slice(0, MAX_ROWS)) lines.push(rowOf(e));
    if (list.length > MAX_ROWS) lines.push(`- …其余 ${list.length - MAX_ROWS} 条`);
  }
  for (const box of [2, 3]) {
    const list = g.by[box];
    if (!list.length) continue;
    lines.push('', `## ${BOX_LABEL[box]}（${list.length}）`);
    for (const e of list.slice(0, MAX_ROWS)) lines.push(`- ${dayOf(e)}  ${makeTitle(e)}${trustMark(e)}  ｜ \`${e.id}\``);
    if (list.length > MAX_ROWS) lines.push(`- …其余 ${list.length - MAX_ROWS} 条`);
  }
  return lines.join('\n') + '\n';
}

export function renderSunk(groups, now = new Date()) {
  const rows = [];
  for (const g of groups) for (const e of g.by[4]) rows.push({ branch: g.branch, e });
  rows.sort((a, b) => String(b.e.ts || '').localeCompare(String(a.e.ts || '')));
  const lines = [
    '# 沉底',
    '',
    `> 生成物，别手改。box=4：很久没被翻过，枝页里已不再出现。共 ${rows.length} 条。`,
    '> 想捞：memory_get <id>（翻一次会把它拉回浅层），或 memory_search。',
    '',
  ];
  for (const { branch, e } of rows) lines.push(`- ${dayOf(e)}  ${makeTitle(e)}${trustMark(e)}  ｜ ${branch} ｜ \`${e.id}\``);
  return lines.join('\n') + '\n';
}

export function generate({ leaves = readLeaves(), dry = true, print = false } = {}) {
  const live = liveLeaves(leaves);
  const groups = buildGroups(live);
  const now = new Date();
  const dir = renderDirectory(groups, live.length, now);
  const pages = new Map(groups.map((g) => [g.branch, renderBranch(g)]));
  const sunk = renderSunk(groups, now);

  if (print) process.stdout.write(dir);
  if (!dry) {
    fs.mkdirSync(BRANCH_DIR, { recursive: true });
    fs.writeFileSync(DIR_FILE, dir, 'utf8');
    fs.writeFileSync(SUNK_FILE, sunk, 'utf8');
    for (const name of fs.readdirSync(BRANCH_DIR)) {
      if (!name.endsWith('.md')) continue;
      if (!pages.has(name.replace(/\.md$/, ''))) fs.rmSync(path.join(BRANCH_DIR, name), { force: true });
    }
    for (const [branch, text] of pages) {
      fs.writeFileSync(path.join(BRANCH_DIR, `${branch.replace(/[\\/:*?"<>|]/g, '_')}.md`), text, 'utf8');
    }
  }
  const counts = [0, 1, 2, 3, 4].map((i) => groups.reduce((n, g) => n + g.by[i].length, 0));
  return {
    total: live.length,
    branches: groups.length,
    boxes: counts,
    dirChars: dir.length,
    sunkChars: sunk.length,
    pageChars: [...pages.values()].map((t) => t.length),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dry = process.argv.includes('--dry');
  const print = process.argv.includes('--show');
  const r = generate({ dry, print });
  const pages = r.pageChars;
  console.log(
    `条目 ${r.total} ｜ 枝 ${r.branches} ｜ 新 ${r.boxes[0]} 浅 ${r.boxes[1]} 中 ${r.boxes[2]} 深 ${r.boxes[3]} 沉底 ${r.boxes[4]} ｜ 目录 ${r.dirChars} 字 ｜ 枝页平均 ${Math.round(pages.reduce((a, b) => a + b, 0) / pages.length)} 字${dry ? '（dry）' : '（已写入）'}`,
  );
}
