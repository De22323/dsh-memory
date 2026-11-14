// memory-links.mjs -- 给同一枝里的记忆自动连线（高置信度，宁缺毋滥）
//
// 规则（2026-11-08 定）：只在**同一枝**里找，满足以下任一条才连：
//   ① 关键词重叠 ≥ 2 个
//   ② 正文相似度（字符 bigram Jaccard）≥ 0.30
//   ③ 关键词重叠 1 个 + 时间差 ≤ 14 天
// 每条最多连 LINKS_MAX 条；双向写入（A 连 B，B 也连 A）。
//
// 两种用法：
//   node tools\memory-links.mjs [--dry]       ← 手动跑
//   await runLinks()                          ← 从 writeProjection 里自动跑（2026-11-08 接进闭环）
//
// ⚠️ 写回必须用**全量**（all）：首次跑这条时用了 live，把 3 条被取代的条目写没了。

import fs from 'node:fs';
import path from 'node:path';
import { HOME, generate, liveLeaves, readLeaves } from './memory-tree.mjs';

const LEAVES = process.env.MEM_LEAVES || path.join(HOME, 'memory', '记忆', '条目.jsonl');
const LINKS_MAX = Number(process.env.MEM_LINKS_MAX) || 3;
const dayMs = 86400_000;
const day = (e) => Date.parse(e.ts || e.created_at) || 0;

function bigrams(s) {
  const t = String(s ?? '').replace(/[\s，。、！？!?~～.…"'（）()「」【】:：;；]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
const kwOf = (e) => (Array.isArray(e.kw) ? e.kw.map(String) : []).filter(Boolean);

const pairScore = (a, b) => {
  const ka = kwOf(a); const kb = kwOf(b);
  const overlap = ka.filter((x) => kb.includes(x)).length;
  const sim = jaccard(a.content, b.content);
  const days = Math.abs(day(a) - day(b)) / dayMs;
  if (overlap >= 2) return { score: 2 + overlap + (sim >= 0.2 ? 1 : 0), why: `kw${overlap}` };
  if (sim >= 0.30) return { score: 2 + sim, why: `sim${sim.toFixed(2)}` };
  if (overlap >= 1 && days <= 14) return { score: 1.5, why: `kw1+近${Math.round(days)}天` };
  return null;
};

/** 算连线并按需写盘；返回统计。 */
export function runLinks({ dry = false, log = () => {}, updateTree = false } = {}) {
  const all = readLeaves(LEAVES);
  const entries = liveLeaves(all);

  const byBranch = new Map();
  for (const e of entries) {
    const b = (Array.isArray(e.path) && e.path.length ? e.path.join('/') : e.parent) || 'b-未归类';
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(e);
  }

  const links = new Map();
  let pairs = 0;
  for (const [, arr] of byBranch) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const hit = pairScore(arr[i], arr[j]);
        if (!hit) continue;
        pairs++;
        for (const [from, to] of [[arr[i], arr[j]], [arr[j], arr[i]]]) {
          if (!links.has(from.id)) links.set(from.id, []);
          links.get(from.id).push({ to: to.id, score: hit.score, why: hit.why, title: to.title || '' });
        }
      }
    }
  }
  for (const [id, list] of links) {
    list.sort((a, b) => b.score - a.score);
    links.set(id, list.slice(0, LINKS_MAX));
  }

  const withLinks = [...links.keys()].length;
  const sample = [...links.entries()].slice(0, 6);

  if (dry) {
    log(`条目 ${entries.length} ｜ 候选对 ${pairs} ｜ 有连线的条目 ${withLinks}（dry：没写盘）`);
    return { total: entries.length, pairs, withLinks, sample, wrote: false };
  }

  const out = all.map((e) => (links.has(e.id) ? { ...e, links: links.get(e.id).map((l) => l.to) } : e));
  fs.writeFileSync(LEAVES, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  if (updateTree) {
    try { generate({ dry: false }); } catch { /* 静默 */ }
  }
  return { total: entries.length, pairs, withLinks, sample, wrote: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dry = process.argv.includes('--dry');
  const r = runLinks({ dry, log: console.log });
  if (dry) {
    console.log(`条目 ${r.total} ｜ 候选对 ${r.pairs} ｜ 有连线的条目 ${r.withLinks}`);
    for (const [id, list] of r.sample) {
      console.log(`\n${id}`);
      for (const l of list) console.log(`   ↔ ${l.to}  (${l.why})  ${l.title}`);
    }
    console.log('\n（dry：没写盘）');
  } else {
    console.log(`已写盘：${r.withLinks} 条带连线（共 ${r.total} 条）`);
  }
}
