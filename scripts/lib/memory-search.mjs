// memory-search.mjs -- 检索核心（memory-get 的 search 与 memory-eval 共用，别各自复制一份）。
//
// 组成（2026-10-23 定稿 · 2026-10-28 加同义改写层）：
//   · 中文 bigram 拆词（整串 + 碎片），英文按词边界
//   · BM25（k1=1.2, b=0.75）正文 + kw 字段加权
//   · 枝命中（枝名/别名，数字占比 >40% 的日期枝不算）
//   · 整串精确命中加成 + Jaccard bigram 改写兜底
//   · 同义改写（查询命中触发短语 → 补正文里真会出现的词，权重打折）
//   · 重要度微调（只在有基础命中时加）
//   · MMR 选结果（别一次给 5 条几乎一样的）

import { BRANCH_ALIAS } from '../memory-index.mjs';
import { EXPAND_RULES } from './memory-synonyms.mjs';
import { makeSemanticScorer } from './memory-semantic.mjs';
import { semanticScores as bgeScores } from './memory-bge.mjs';

/** 真语义层（2026-11-12 晚）：BGE-small-zh-v1.5 的余弦。
 *  建了、也测了，但**默认关闭**（MEM_BGE=1 才开）—— 实测它没有超过现有的字面检索：
 *    · 单干：留出集 top1 15/24（字面 18/24）
 *    · 混排 α=0.15~0.6：top1 不变，相关率 104→105/126
 *    · 重排 top5/8（β=0.5）：留出集掉到 17/24
 *    · 翻盘门（余弦差 ≥Δ）：Δ=0.12 留出集 19/24，但回归组 41/42 → 39/42
 *  ⇒ 结论：瓶颈不是"缺语义向量"。代码和索引留着，换模型（bge-base / 更大的）再试时不用重写。 */
const BGE_ON = process.env.MEM_BGE === '1';
const BGE_DEFAULT_ALPHA = 0.25;
const BGE_ALPHA = Number(process.env.MEM_BGE_ALPHA ?? BGE_DEFAULT_ALPHA);
const BGE_W = Number(process.env.MEM_BGE_W ?? 0);
const BGE_FLOOR = Number(process.env.MEM_BGE_FLOOR ?? 0.55);
const BGE_ONLY = Number(process.env.MEM_BGE_ONLY ?? 0.62);
/** 重排（实验层）：取字面前 K 名，按 (1-β)·字面归一 + β·余弦 重排。0 = 关。 */
const BGE_RERANK = Number(process.env.MEM_BGE_RERANK ?? 0);
const BGE_BETA = Number(process.env.MEM_BGE_BETA ?? 0.6);
/** 语义翻盘门槛（实验层）：语义第一名比字面第一名的余弦高出多少，才有资格把它顶下去。0 = 关。 */
const BGE_FLIP = Number(process.env.MEM_BGE_FLIP ?? 0);

/** 同义/概念扩词权重（2026-11-08 实测 1.2 最平衡：回归组 top1 不降、语义组 75%→83%；
 *  再往上 1.6/2.0 会开始挤掉回归组（96.7%→93.3%）。可用 MEM_EXPAND_W 临时覆盖。 */
const EXPAND_W = Number(process.env.MEM_EXPAND_W ?? 1.2);

/** 语义层（2026-11-08 加）：只做"字面 0 命中时的兜底"，不做加分。
 *  实测（42 条评估集）：给有字面命中的条目加语义分，回归组 top1 从 96.7% 掉到 93.3% —— 纯噪声，
 *  所以加分这条路关掉了（SEM_W=0）。留下的是：一个字都对不上、但余弦 ≥ SEM_ONLY 的，才捞回来。
 *  真正的"语义"靠 memory-synonyms.mjs 里的概念表。 */
const SEM_ON = process.env.MEM_SEM !== '0';
const SEM_FLOOR = Number(process.env.MEM_SEM_FLOOR ?? 0.12);
const SEM_W = Number(process.env.MEM_SEM_W ?? 0);
const SEM_ONLY = Number(process.env.MEM_SEM_ONLY ?? 0.18);

/** 沉降权重（2026-11-11 晚加）：盒子 0 新卡 / 1 浅 / 2 中 / 3 深 / 4 沉底。
 *  只压排名、不设门槛 —— 深的老记忆照样能被搜出来，只是让位给同分的新条目。
 *  曲线是温和的：最深也只到 0.62；真要更狠可 MEM_BOX_DAMP 覆盖。 */
const BOX_DAMP = (() => {
  const raw = process.env.MEM_BOX_DAMP;
  if (raw) {
    const arr = raw.split(',').map(Number).filter(Number.isFinite);
    if (arr.length === 5) return arr;
  }
  return [1, 0.97, 0.9, 0.8, 0.62];
})();

const DIGIT_LIKE = (s) => (String(s).match(/\d/g) || []).length / Math.max(1, String(s).length);
const STOP = new Set(['dsh', 'the', 'and', 'for', 'with']);

/** 单字层（2026-11-11 深夜实验）：中文只切 bigram 时，「插件崩」里的「崩」根本不是词
 *  （切成 插件/件崩），所以正文只写「崩了」的条目一个词都对不上。补一层单字召回，权重压低。 */
const UNI_W = Number(process.env.MEM_UNI_W ?? 0.6);
/** 标题层（2026-11-11 深夜实验）：title 是正文的摘要，之前完全没进索引。 */
const TITLE_W = Number(process.env.MEM_TITLE_W ?? 0);
/** 覆盖度层（2026-11-11 深夜实验）：查询里的字，正文覆盖了多少比例。
 *  BM25 是"命中多少"相加，一个词命中 5 次能盖过"两个概念各命中一次"；
 *  这层专门奖励"整句的词都沾上了"的条目（插件+崩 都有的，先过只有 插件 的）。 */
const COV_W = Number(process.env.MEM_COV_W ?? 3);
/** 稀有词加成（2026-11-11 深夜实验）：查询里那个"只有一两条记忆里出现过"的词（善后 / 中招），
 *  命中就额外加权 —— 否则一条长文靠重复"电脑/插件"这种常见词就能把它压下去。 */
const RARE_W = Number(process.env.MEM_RARE_W ?? 0);
const RARE_DF = Number(process.env.MEM_RARE_DF ?? 3);
/** 覆盖度乘数（2026-11-11 深夜实验）：把覆盖度从"加分"改成"乘分" —— 只有一种念头的可相关，
 *  查询里两块概念都沾上的才不被压下去。0 = 关，越大越狠。 */
const COV_MUL = Number(process.env.MEM_COV_MUL ?? 0);

function uniTermsOf(s) {
  const out = [];
  const t = String(s ?? '').toLowerCase();
  for (const m of t.matchAll(/[a-z0-9_@./-]{2,}/g)) out.push(m[0]);
  for (const ch of (t.match(/[\u4e00-\u9fa5]/g) || [])) out.push(ch);
  return out;
}

function termsOf(s) {
  const out = [];
  const t = String(s ?? '').toLowerCase();
  for (const m of t.matchAll(/[a-z0-9_@./-]{2,}/g)) out.push(m[0]);
  for (const run of (t.match(/[\u4e00-\u9fa5]+/g) || [])) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

function branchHit(parent, qLower) {
  if (!parent) return 0;
  const name = String(parent).replace(/^b-/, '').toLowerCase();
  if (!name || DIGIT_LIKE(name) > 0.4) return 0;
  if (name.length >= 2 && qLower.includes(name)) return 1;
  const qWords = (qLower.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]{2,}/g) || []).filter((w) => !STOP.has(w));
  if (qWords.some((w) => name.includes(w))) return 0.9;
  for (const [k, aliases] of Object.entries(BRANCH_ALIAS)) {
    const kl = k.toLowerCase();
    if (!(name.includes(kl) || kl.includes(name))) continue;
    if ([kl, ...aliases].some((x) => qLower.includes(x))) return 1;
  }
  return 0;
}

/**
 * @param {Array} leaves 条目（readLeaves() 的结果）
 * @param {string} q 查询
 * @param {{ n?: number }} opts
 * @returns {Array<{ r: object, s: number, content: string[] }>} 按分数降序
 */
export function searchLeaves(leaves, q, { n = 5 } = {}) {
  const nInt = Math.max(1, Math.min(50, Number(n) || 5));
  if (!q) return [];
  const list = Array.isArray(leaves) ? leaves : [];
  const N = list.length;
  if (!N) return [];

  const docs = list.map((r) => {
    const content = termsOf(r.content);
    const kw = termsOf((r.kw ?? []).join(' '));
    const title = termsOf(r.title ?? '');
    const uni = UNI_W > 0 ? uniTermsOf(`${r.content ?? ''}`) : [];
    const chars = (COV_W > 0 || COV_MUL > 0) ? new Set((String(r.content ?? '').toLowerCase().match(/[\u4e00-\u9fa5]/g) || [])) : null;
    return { r, content, kw, title, uni, chars, dl: content.length || 1 };
  });
  const avgdl = docs.reduce((a, d) => a + d.dl, 0) / Math.max(1, N);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.content)) df.set(t, (df.get(t) ?? 0) + 1);
  const dfUni = new Map();
  if (UNI_W > 0) for (const d of docs) for (const t of new Set(d.uni)) dfUni.set(t, (dfUni.get(t) ?? 0) + 1);
  // 覆盖度层用的单字 df（2026-11-11 深夜改：按字的稀有度加权，见 COV_W 注释）
  const dfChar = new Map();
  if (COV_W > 0 || COV_MUL > 0) for (const d of docs) for (const t of d.chars ?? []) dfChar.set(t, (dfChar.get(t) ?? 0) + 1);

  const qTerms = [...new Set(termsOf(q))];
  const qUni = UNI_W > 0 ? [...new Set(uniTermsOf(q))] : [];
  const qChars = (COV_W > 0 || COV_MUL > 0)
    ? [...new Set((String(q).toLowerCase().match(/[\u4e00-\u9fa5]/g) || []).filter((c) => !'的了是在吗呢吧啊么和与就都也还把被'.includes(c)))]
    : [];
  // 每个查询字的 rarity 权重：越少见的字越值钱（"中招/善后" 这类词不能被"电脑"这种高频字盖过）
  const charIdf = (c) => Math.log(1 + (N - (dfChar.get(c) ?? 0) + 0.5) / ((dfChar.get(c) ?? 0) + 0.5));
  const qCharW = qChars.map((c) => [c, charIdf(c)]);
  const qCharTotal = qCharW.reduce((a, [, w]) => a + w, 0) || 1;
  const qLower = String(q).toLowerCase();

  // 同义改写：查询命中触发短语 → 把正文里真会出现的词也加进打分
  const extraTerms = [];
  for (const rule of EXPAND_RULES) {
    if (rule.when.some((p) => qLower.includes(String(p).toLowerCase()))) {
      for (const a of rule.add) extraTerms.push(...termsOf(a));
    }
  }
  const qSet = new Set(qTerms);
  const expTerms = [...new Set(extraTerms)].filter((t) => !qSet.has(t));

  const K1 = 1.2, B = 0.75;
  const idfIn = (m, t) => Math.log(1 + (N - (m.get(t) ?? 0) + 0.5) / ((m.get(t) ?? 0) + 0.5));
  const idfOf = (t) => idfIn(df, t);
  const tfOf = (arr) => {
    const m = new Map();
    for (const t of arr) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const bm25Field = (tfs, dl, terms, dfMap = df) => {
    let s = 0;
    for (const t of terms) {
      const f = tfs.get(t) ?? 0;
      if (!f) continue;
      s += idfIn(dfMap, t) * (f * (K1 + 1)) / (f + K1 * (1 - B + (B * dl) / avgdl));
    }
    return s;
  };

  // 语义层：正文 + 标题 + 关键词 + 枝名一起去比
  const semScores = SEM_ON
    ? makeSemanticScorer(list, (r) => `${r.content ?? ''} ${r.title ?? ''} ${(r.kw ?? []).join(' ')} ${r.parent ?? ''}`)(q)
    : null;
  // 真语义层（BGE）：id → 余弦
  const bge = BGE_ON ? bgeScores(list, q) : null;

  const scored = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const s1 = bm25Field(tfOf(d.content), d.dl, qTerms);
    const s2 = bm25Field(tfOf(d.kw), Math.max(1, d.kw.length), qTerms) * 1.6;
    const s3 = branchHit(d.r.parent, qLower) * 2;
    const s4 = String(d.r.content ?? '').toLowerCase().includes(qLower) ? 3 : 0;
    const s5 = jaccard(qTerms, d.content) * 2;
    const s7 = expTerms.length
      ? (bm25Field(tfOf(d.content), d.dl, expTerms)
        + bm25Field(tfOf(d.kw), Math.max(1, d.kw.length), expTerms) * 0.8) * EXPAND_W
      : 0;
    const cov = (COV_W > 0 || COV_MUL > 0) && qChars.length >= 2
      ? (() => {
        const hit = qCharW.reduce((a, [c, w]) => a + (d.chars.has(c) ? w : 0), 0) / qCharTotal;
        return hit * hit;
      })()
      : 0;
    const base = s1 + s2 + s3 + s4 + s5 + s7
      + (TITLE_W > 0 ? bm25Field(tfOf(d.title), Math.max(1, d.title.length), qTerms) * TITLE_W : 0)
      + (UNI_W > 0 ? bm25Field(tfOf(d.uni), Math.max(1, d.uni.length), qUni, dfUni) * UNI_W : 0)
      + (RARE_W > 0
        ? (() => {
          const set = d._termSet ?? (d._termSet = new Set(d.content));
          let s = 0;
          for (const t of qTerms) if ((df.get(t) ?? 0) > 0 && df.get(t) <= RARE_DF && set.has(t)) s += idfOf(t);
          return s * RARE_W;
        })()
        : 0)
      + (COV_W > 0 ? cov * COV_W : 0);
    const cos = semScores ? semScores[i] : 0;
    const bcos = bge ? (bge.get(d.r.id) ?? 0) : 0;
    let semS = 0;
    if (base > 0) {
      semS = Math.max(0, cos - SEM_FLOOR) * SEM_W;
      if (BGE_W > 0) semS += Math.max(0, bcos - BGE_FLOOR) * BGE_W;
    } else if (SEM_ON && cos >= SEM_ONLY) {
      // 一个字都不重、但意思很近的，也放进来（分数压低，别盖过字面命中）
      semS = (cos - SEM_ONLY) * 12;
    } else if (BGE_ON && bcos >= BGE_ONLY) {
      // 真语义兜底：字面 0 命中、但余弦够近 —— 这是 embedding 唯一比关键词强的地方
      semS = (bcos - BGE_ONLY) * 12;
    } else {
      continue;
    }
    if (base + semS <= 0) continue;
    const s6 = ((Number(d.r.imp) || 3) - 3) * 0.35;
    // 反馈权重（2026-11-08）：他说过不对的降权、说过有用的加权
    const trust = Number(d.r.trust) || 0;
    const mult = trust < 0 ? 0.55 : trust > 0 ? 1.15 : 1;
    // 沉降权重（2026-11-11 晚）：盒子越深排得越靠后，但**永不归零** —— 遗忘是排序，不是删除。
    // 在这之前盒子只显示在角标里，检索根本没用它，等于白沉降。
    const damp = BOX_DAMP[Math.max(0, Math.min(4, Number(d.r.box) || 0))];
    // 覆盖度乘数（实验层，COV_MUL=0 时是 1）：概念没覆盖全的，整体打个折
    const covMul = COV_MUL > 0 && qChars.length >= 2 ? (1 - COV_MUL) + COV_MUL * cov : 1;
    scored.push({
      r: d.r, content: d.content,
      base, semS, bcos, s6, mult, damp, covMul,
    });
  }

  // 真语义混排（BGE）：字面分和余弦不是一个量纲（字面 15~46，余弦 0.4~0.7），
  // 直接相加等于没加。这里把余弦乘上"本轮最大字面分"，换算到同一把尺子上，再用 α 控制话语权：
  //   α=0     → 只当兜底（字面 0 命中的才捞进来）
  //   α=0.2~0.3 → 只影响"字面分接近"的那些，不推翻明显正确的字面命中
  const maxBase = scored.reduce((m, x) => Math.max(m, x.base), 0) || 1;
  for (const x of scored) {
    const bgeBlend = BGE_ALPHA > 0 ? BGE_ALPHA * Math.max(0, x.bcos) * maxBase : 0;
    x.s = (x.base + x.semS + bgeBlend + x.s6) * x.mult * x.damp * x.covMul;
  }

  // 语义重排（实验层，MEM_BGE_RERANK=1 才开）：取字面前 K 名，改成
  //   score = (1-β)·(字面分/第一名) + β·余弦
  // 混排的 α 打不过"字面自信但选错"的情况（字面 46 分 vs 余弦最多折 20 分），
  // 只有把候选框住、再让余弦重新排序，才可能翻盘。
  if (BGE_ON && BGE_RERANK > 0 && bge && scored.length) {
    scored.sort((a, b) => b.s - a.s);
    const head = scored.slice(0, BGE_RERANK);
    const base0 = head[0].s || 1;
    for (const x of head) {
      const ln = x.s / base0;
      x.s = ((1 - BGE_BETA) * ln + BGE_BETA * Math.max(0, x.bcos)) * base0;
    }
    scored.sort((a, b) => b.s - a.s);
  }

  // 语义翻盘（实验层，MEM_BGE_FLIP=Δ 才开）：字面第一名自信但选错的场面，
  // 只有"语义觉得另一个明显更像"时才有资格推翻它 —— 门槛是余弦差 Δ。
  // Δ 越大越保守；Δ=0 就是"余弦说了算"，不能那么干。
  if (BGE_ON && BGE_FLIP > 0 && bge && scored.length) {
    scored.sort((a, b) => b.s - a.s);
    let semTopId = null, semTopCos = -1;
    for (const [id, cos] of bge) if (cos > semTopCos) { semTopCos = cos; semTopId = id; }
    const lexTop = scored[0];
    const cosLexTop = lexTop.bcos ?? 0;
    if (semTopId && semTopId !== lexTop.r.id && (semTopCos - cosLexTop) >= BGE_FLIP) {
      const i = scored.findIndex((x) => x.r.id === semTopId);
      const bump = lexTop.s * 1.02 + 1e-6;
      if (i >= 0) {
        const cand = scored.splice(i, 1)[0];
        cand.s = Math.max(cand.s, bump);
        scored.unshift(cand);
      }
    }
  }

  const picked = [];
  const pool = scored.sort((a, b) => b.s - a.s);
  while (picked.length < nInt && pool.length) {
    let best = null, bestV = -Infinity;
    for (const c of pool) {
      let sim = 0;
      for (const p of picked) sim = Math.max(sim, jaccard(c.content, p.content));
      const v = c.s * (1 - 0.45 * sim);
      if (v > bestV) { bestV = v; best = c; }
    }
    picked.push(best);
    pool.splice(pool.indexOf(best), 1);
  }
  picked.sort((a, b) => b.s - a.s);
  return picked;
}
