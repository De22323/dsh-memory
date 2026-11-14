/**
 * 把工作区 tools\ 里最新的记忆脚本同步进插件 scripts\。
 *
 * 为什么要同步：插件自带一份脚本（不依赖工作区 tools\），但真身在 tools\ 里，
 * 平时改的是 tools\，所以要跑这个把副本刷新。
 *
 * 用法：node sync-scripts.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = process.env.DSH_WORKSPACE || 'C:\\Users\\33911\\Documents\\deepseek-harness\\default-workspace';
const TOOLS = join(WS, 'tools');
const DST = join(HERE, 'scripts');
const DST_LIB = join(DST, 'lib');

const ROOT_FILES = [
  'memory-index.mjs', 'memory-tree.mjs', 'memory-get.mjs', 'memory-add.mjs',
  'memory-feedback.mjs', 'memory-sink.mjs', 'memory-decay.mjs', 'memory-boxes.mjs',
  'memory-archive.mjs', 'memory-links.mjs',
];
const LIB_FILES = [
  'memory-search.mjs', 'memory-card.mjs', 'memory-manifest.mjs',
  'memory-semantic.mjs', 'memory-synonyms.mjs',
  // memory-bge.mjs 不同步：正本带本机 python 路径（有默认值），副本必须不带任何本机路径。
  // 以后改语义层，两边都要手动看一眼。
];

mkdirSync(DST_LIB, { recursive: true });
let n = 0;
for (const f of ROOT_FILES) {
  const src = join(TOOLS, f);
  if (!existsSync(src)) { console.warn('skip (missing in tools):', f); continue; }
  copyFileSync(src, join(DST, f));
  n++;
}
for (const f of LIB_FILES) {
  const src = join(TOOLS, 'lib', f);
  if (!existsSync(src)) { console.warn('skip (missing in tools):', f); continue; }
  copyFileSync(src, join(DST_LIB, f));
  n++;
}
console.log(`synced ${n} files from ${TOOLS} -> ${DST}`);
