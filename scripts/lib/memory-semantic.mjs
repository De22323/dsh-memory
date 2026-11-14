// memory-semantic.mjs -- 语义检索层（本地、零依赖、不联网）。
//
// 现实：没有本地 embedding 模型，"语义"只能靠两样东西 ——
//   ① 字的模糊匹配：中文 2/3 字组 + 英文词，做精确的稀疏余弦（不做哈希，避免随机碰撞）。
//      它管的是"字对不齐但沾边"：错字、简写、词序、中英混写（sleep / 睡眠）。
//   ② 口语 → 正文词的概念表（memory-concepts.mjs）。它管的是"一个词都不重但意思近"。
//
// 权重：概念扩词单独一层（CONCEPT_W），稀疏余弦作为 BM25 之外的补充信号（SEM_W）。
// 关掉：MEM_SEM=0

const CJK_RUN = /[\u4e00-\u9fa5]+/g;
const LATIN = /[a-z0-9_@./-]{2,}/g;

/** 文本 -> 特征计数（中文 2/3 字组、英文词） */
export function featuresOf(text) {
  const out = [];
  const t = String(text ?? '').toLowerCase();
  for (const m of t.matchAll(LATIN)) out.push('w:' + m[0]);
  for (const run of t.match(CJK_RUN) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 2 <= run.length; i++) out.push('c2:' + run.slice(i, i + 2));
    if (run.length >= 3) {
      for (let i = 0; i + 3 <= run.length; i++) out.push('c3:' + run.slice(i, i + 3));
    }
  }
  return out;
}

function countsOf(features) {
  const m = new Map();
  for (const f of features) m.set(f, (m.get(f) ?? 0) + 1);
  for (const [k, v] of m) m.set(k, 1 + Math.log(v));
  return m;
}

function vectorOf(counts, idf) {
  const v = new Map();
  let norm = 0;
  for (const [f, tf] of counts) {
    const w = tf * (idf ? (idf.get(f) ?? 3) : 1);
    v.set(f, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [f, w] of v) v.set(f, w / norm);
  return v;
}

function cosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [f, w] of small) {
    const x = big.get(f);
    if (x) s += w * x;
  }
  return s;
}

const CACHE = new WeakMap();

function indexOf(items, textOf) {
  const hit = CACHE.get(items);
  if (hit) return hit;

  const counts = items.map((r) => countsOf(featuresOf(textOf(r))));
  const df = new Map();
  for (const c of counts) for (const f of c.keys()) df.set(f, (df.get(f) ?? 0) + 1);

  const N = counts.length;
  const idf = new Map();
  for (const [f, d] of df) idf.set(f, Math.log((N + 1) / d) + 1);

  const vectors = counts.map((c) => vectorOf(c, idf));
  const index = { vectors, idf };
  CACHE.set(items, index);
  return index;
}

/**
 * 造一个"查询 -> 每条余弦值"的打分器（索引按 items 数组身份缓存）。
 * @param {Array} items 条目（readLeaves 的结果）
 * @param {(r:any)=>string} textOf 取参与比对的文本
 * @returns {(query: string) => number[]}
 */
export function makeSemanticScorer(items, textOf) {
  return (query) => {
    const index = indexOf(items, textOf);
    const qv = vectorOf(countsOf(featuresOf(query)), index.idf);
    return index.vectors.map((v) => cosine(qv, v));
  };
}
