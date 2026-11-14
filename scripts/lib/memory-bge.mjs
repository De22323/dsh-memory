// memory-bge.mjs —— 真语义层（BGE-small-zh-v1.5，ONNX，本地跑）。
//
// 和其他记忆工具的分工：
//   · 条目向量离线算好，落在 memory\记忆\embeddings-bge.json（build-index.mjs 生成）
//   · 查询向量现算：spawn 一个 python 进程（模型 90 MB，单次 ~1 s），结果进内存缓存
//   · 这里只给余弦，排序怎么用由 memory-search.mjs 决定
//
// 为什么是"同步 spawn"而不是常驻服务：检索链路（memory-get / memory-eval）全是同步函数，
// 改成 async 要动的地方太多；一次查询多 1 秒，换来不破坏既有结构，这个交换划算。
// 沙箱下 spawnSync 不能用管道 → 输入输出都走临时文件。

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WS = process.env.MEM_HOME || process.env.MEM_BGE_WS || process.cwd();
const INDEX = join(WS, 'memory', '记忆', 'embeddings-bge.json');
// 可选语义层：不配 python 路径就自动降级为纯字面检索（插件发布版不带任何本机路径）
const PY = process.env.MEM_BGE_PY || '';
const EMBED_PY = join(WS, 'tools', 'semantic', 'embed.py');
const TMP = join(WS, 'runtime', 'bge');

let indexCache = null;
let indexMtime = 0;
const queryCache = new Map();
const QUERY_CACHE_MAX = 80;
const QDISC = join(TMP, 'qcache.json');
let qdiscLoaded = false;
let qdiscDirty = false;

/** 查询向量落盘缓存：同样的问题（评估集、反复跑）不用每次重算 python。 */
function loadQDisc() {
  if (qdiscLoaded) return;
  qdiscLoaded = true;
  try {
    if (!existsSync(QDISC)) return;
    const json = JSON.parse(readFileSync(QDISC, 'utf8'));
    for (const [k, arr] of Object.entries(json ?? {})) {
      if (Array.isArray(arr) && arr.length) queryCache.set(k, Float32Array.from(arr));
    }
  } catch { /* 坏了就当没有 */ }
}

function saveQDisc() {
  if (!qdiscDirty) return;
  try {
    mkdirSync(TMP, { recursive: true });
    const obj = {};
    for (const [k, v] of queryCache) obj[k] = Array.from(v);
    writeFileSync(QDISC, JSON.stringify(obj), 'utf8');
    qdiscDirty = false;
  } catch { /* ignore */ }
}

function b64ToF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function loadIndex() {
  try {
    if (!existsSync(INDEX)) return null;
    const st = readFileSync(INDEX, 'utf8');
    const mtime = st.length; // 粗指纹：文件长度变了就重读
    if (indexCache && indexMtime === mtime) return indexCache;
    const json = JSON.parse(st);
    const items = new Map();
    for (const [id, b64] of Object.entries(json.items ?? {})) items.set(id, b64ToF32(b64));
    indexCache = { dim: json.dim, items, builtAt: json.builtAt, count: items.size };
    indexMtime = mtime;
    return indexCache;
  } catch {
    return null;
  }
}

/** 查询向量（同步，~1 s，命中缓存 <1 ms）。失败返回 null —— 检索退回纯字面，不报错。 */
export function embedQuery(text) {
  const key = String(text ?? '').trim();
  if (!key) return null;
  if (!PY) return null; // 没配 python 就没有语义层
  loadQDisc();
  if (queryCache.has(key)) return queryCache.get(key);
  try {
    mkdirSync(TMP, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const inPath = join(TMP, `q-in-${stamp}.json`);
    const outPath = join(TMP, `q-out-${stamp}.json`);
    writeFileSync(inPath, JSON.stringify({ texts: [key], mode: 'query' }), 'utf8');
    const res = spawnSync(PY, [EMBED_PY, '--in', inPath, '--out', outPath], {
      cwd: WS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000,
      encoding: 'utf8',
    });
    let vec = null;
    if (res.status === 0 && existsSync(outPath)) {
      const json = JSON.parse(readFileSync(outPath, 'utf8'));
      if (json.vectors?.length) vec = Float32Array.from(json.vectors[0]);
    }
    for (const p of [inPath, outPath]) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
    if (!vec) return null;
    if (queryCache.size >= QUERY_CACHE_MAX) queryCache.clear();
    queryCache.set(key, vec);
    qdiscDirty = true;
    saveQDisc();
    return vec;
  } catch {
    return null;
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 给一批条目打语义分。
 * @returns {Map<string, number>|null} id → cosine（0..1），不可用时 null
 */
export function semanticScores(leaves, query) {
  const idx = loadIndex();
  if (!idx) return null;
  const qv = embedQuery(query);
  if (!qv) return null;
  const out = new Map();
  for (const r of leaves) {
    const dv = idx.items.get(r.id);
    if (dv) out.set(r.id, cosine(qv, dv));
  }
  return out.size ? out : null;
}

/** 给 CLI/评估脚本看的自检信息。 */
export function bgeStatus() {
  const idx = loadIndex();
  return {
    index: idx ? { count: idx.count, dim: idx.dim, builtAt: idx.builtAt } : null,
    python: PY ? existsSync(PY) : false,
    model: existsSync(join(WS, 'runtime', 'bge', 'bge-small-zh-v1.5.onnx')),
  };
}
