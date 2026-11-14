// memory-manifest.mjs -- 自动动作的"收据"：每个会改记忆文件的脚本，动手前记下原值，
// 改完留下一份可回滚的记录。没有它，自动化就只能靠"整份备份 + 手工找"，不敢放开跑。
//
// 记录位置：runtime\memory-manifests\<动作>-<时间戳>.json
// 结构：{ actor, action, ts, files: [{ path, before, beforeHash, afterHash }] }
//   before 存全文（条目.jsonl / 状态.md 都在几十 KB 量级，存得起）
//
// 用法（在脚本里）：
//   import { writeManifest } from './lib/memory-manifest.mjs';
//   writeManifest({ actor: 'memory-decay', action: 'decay', files: [{ path: LEAVES, before, after }] });
//
// 回滚：node tools\memory-rollback.mjs <manifest 文件名>   （或 `list` 列全部）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = path.resolve(import.meta.dirname, '..', '..');
export const MANIFEST_DIR = process.env.MEM_MANIFEST_DIR || path.join(HOME, 'runtime', 'memory-manifests');

export function hash(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);
}

export function stamp() {
  return new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
}

function rel(p) {
  return path.relative(HOME, p).split(path.sep).join('/');
}

/**
 * 写一份 manifest。files: [{ path, before, after }]（path 是绝对路径，before/after 是全文）。
 * 返回 manifest 文件路径。
 */
export function writeManifest({ actor, action, files }) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const rec = {
    actor,
    action,
    ts: new Date().toISOString(),
    files: files.map((f) => ({
      path: rel(f.path),
      before: f.before,
      beforeHash: hash(f.before),
      afterHash: hash(f.after),
    })),
  };
  const file = path.join(MANIFEST_DIR, `${action}-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  return file;
}

export function listManifests() {
  if (!fs.existsSync(MANIFEST_DIR)) return [];
  return fs.readdirSync(MANIFEST_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const full = path.join(MANIFEST_DIR, n);
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { /* 坏文件跳过 */ }
      return { name: n, full, rec, mtime: fs.statSync(full).mtime };
    })
    .filter((x) => x.rec)
    .sort((a, b) => b.mtime - a.mtime);
}
