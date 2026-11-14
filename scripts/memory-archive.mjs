// memory-archive.mjs -- 超深层归档（Mnemosyne 清单上剩下的那条 · 2026-11-11 深夜做）。
//
// 规则：**沉到底（box 4）＋ 真很久没被碰（≥180 天）** 的叶，正文搬进归档文件，叶子里只留一行。
//   · 不删：整条原文（原 JSON 一行）追加进 memory\归档-旧版本与记录\超深层\沉底-YYYY-MM.jsonl
//   · 叶子留 id / 枝 / kw / 日期 / access，加一个 archived 指针 —— 检索照样找得到
//   · memory_get 取到带 archived 的叶，会自动去归档文件里把全文捞回来
//   · pinned 不归档；被取代 / 过期的叶本来就不参与检索，也不动
//
// 为什么要有它：只在"冷"这一侧有沉降、没有终点，沉底的条目会无限涨；真正需要时
// 翻它们要花带宽，而绝大多数永远不会再被问起。留下一行 = 还记得有过这回事，全文不丢。
//
// 用法：
//   node tools\memory-archive.mjs            # 只看（默认 dry）
//   node tools\memory-archive.mjs --apply    # 真搬（改前备份 + 收据）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLeaves, LEAVES, HOME } from './memory-index.mjs';
import { stateOfBox } from './lib/memory-card.mjs';
import { writeManifest } from './lib/memory-manifest.mjs';

export const ARCHIVE_MIN_DAYS = Number(process.env.MEM_ARCHIVE_MIN_DAYS) || 180;
export const ARCHIVE_BOX = 4;

const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

/** 纯函数：算"哪几条该沉进超深层"。 */
export function planArchive(leaves, now = Date.now(), { minDays = ARCHIVE_MIN_DAYS, box = ARCHIVE_BOX } = {}) {
  const out = [];
  for (const r of leaves) {
    if (!r || r.archived) continue;
    if (r.state === 'pinned' || r.superseded_by || r.valid_to) continue;
    if ((Number(r.box) || 0) < box) continue;
    const born = Date.parse(r.ts || r.created_at || '') || 0;
    const acc = (Array.isArray(r.access) ? r.access : []).map(toMs).filter(Number.isFinite);
    const last = Math.max(born, ...acc);
    if (!Number.isFinite(last)) continue;
    const days = (now - last) / 86400_000;
    if (days < minDays) continue;
    out.push({
      id: r.id, title: r.title || String(r.content ?? '').slice(0, 18),
      chars: String(r.content ?? '').length, days: Math.round(days), box: Number(r.box) || 0,
    });
  }
  return out;
}

/** 归档文件路径（按月一个文件）。 */
export function archivePathFor(now = Date.now(), dir = path.join(HOME, 'memory', '归档-旧版本与记录', '超深层')) {
  const month = new Date(now).toISOString().slice(0, 7);
  return { dir, file: path.join(dir, `沉底-${month}.jsonl`) };
}

/** 真搬：返回 {moved, archiveFile, next}。next 是新的叶数组（不改原数组）。 */
export function applyArchive(leaves, now = Date.now(), { dir, minDays } = {}) {
  const plan = planArchive(leaves, now, { minDays });
  if (!plan.length) return { moved: [], archiveFile: null, next: leaves, plan };
  const { dir: d, file } = archivePathFor(now, dir);
  fs.mkdirSync(d, { recursive: true });
  const byId = new Map(plan.map((p) => [p.id, p]));
  const lines = [];
  const next = leaves.map((r) => {
    if (!byId.has(r.id)) return r;
    lines.push(JSON.stringify({ ...r, archived_at: new Date(now).toISOString() }));
    const p = byId.get(r.id);
    const relRaw = path.relative(HOME, file);
    const rel = relRaw && !relRaw.startsWith('..') ? relRaw.split(path.sep).join('\\') : file;
    return {
      ...r,
      content: `〔沉底归档〕${p.title}（原文 ${p.chars} 字 → ${rel}）`,
      title: p.title,
      archived: { at: new Date(now).toISOString(), file, chars: p.chars },
      state: stateOfBox(r.box),
    };
  });
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { moved: plan, archiveFile: file, next };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const apply = process.argv.includes('--apply');
  const rows = readLeaves();
  const plan = planArchive(rows);
  if (!plan.length) {
    console.log(`没有要归档的：${rows.length} 条叶里，沉底且 ≥${ARCHIVE_MIN_DAYS} 天没被碰的是 0 条。`);
  } else {
    console.log(`计划归档 ${plan.length} 条（沉底 + ≥${ARCHIVE_MIN_DAYS} 天没碰）：`);
    for (const p of plan) console.log(`  ${p.id}  已 ${p.days} 天 / ${p.chars} 字 ｜${p.title}`);
    if (!apply) {
      console.log('\n（默认只看不动。真要搬加 --apply；搬前自动备份。）');
    } else {
      const before = fs.readFileSync(LEAVES, 'utf8');
      const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
      const arch = path.join(HOME, 'memory', '归档-旧版本与记录');
      fs.mkdirSync(arch, { recursive: true });
      fs.copyFileSync(LEAVES, path.join(arch, `条目.jsonl.bak-${stamp}`));
      const { moved, archiveFile, next } = applyArchive(rows, Date.now());
      const nextText = next.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const manifest = writeManifest({ actor: 'memory-archive', action: 'archive', files: [{ path: LEAVES, before, after: nextText }] });
      fs.writeFileSync(LEAVES, nextText, 'utf8');
      console.log(`\n已归档 ${moved.length} 条 → ${path.relative(HOME, archiveFile)}`);
      console.log(`（收据 ${path.basename(manifest)} ｜ 备份 条目.jsonl.bak-${stamp}）`);
    }
  }
}
