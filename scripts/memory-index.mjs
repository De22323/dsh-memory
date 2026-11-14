// memory-index.mjs -- 「干」（索引）生成器。
//
// 方案 1（2026-10-06 定的）：**条目流是唯一真相**，下面两份都是它的投影 ——
//   ① memory\记忆\干.md              —— 完整索引（≤1500 字，给我自己/工具看）
//   ② docs\qq-可公开记忆.md   —— 卡里那一节（2026-10-07 QQ 线摘除，此投影默认关闭；要用就设 MEM_PUBLIC_ON=1）
// 只收 visibility=public 的叶 ⇒ **私档永远不会出现在卡上**（这是 Stage 1 真正买到的东西）。
//
// 固定头（"关于我自己 / 正在学 / 暂不讨论"）是**人写层**，本脚本逐字保留、绝不改写；
// 找不到它就直接放弃（fail-closed），宁可不动。
//
// 用法：node tools\memory-index.mjs [--dry] [--print] [--selftest]

import fs from 'node:fs';
import path from 'node:path';
import { writeManifest } from './lib/memory-manifest.mjs';
import { makeTitle, planBoxOnTouch, stateOfBox } from './lib/memory-card.mjs';

const HERE = import.meta.dirname;
export const HOME = process.env.MEM_HOME || path.dirname(HERE);
// 三个路径都留了环境变量口子：只给测试用（跑夹具副本），生产别设。
export const LEAVES = process.env.MEM_LEAVES || path.join(HOME, 'memory', '记忆', '条目.jsonl');
export const TRUNK = process.env.MEM_TRUNK || path.join(HOME, 'memory', '记忆', '干.md');
export const PUBLIC_MEM = process.env.MEM_PUBLIC || path.join(HOME, 'docs', 'qq-可公开记忆.md');
const BACKUP_DIR = process.env.MEM_BACKUP_DIR || path.join(HOME, 'memory', '归档-旧版本与记录', '写入备份');

export const BUDGET_TRUNK = Number(process.env.MEM_INDEX_CHARS) || 1500;       // 干 全文（给我/工具）
// 2026-10-18：三段预算 —— 常驻（带摘要）+ 折叠（只留枝名）+ 兜底。**绝不静默丢枝**。
export const BUDGET_TRUNK_RESIDENT = Number(process.env.MEM_INDEX_RESIDENT) || 1100;
export const BUDGET_TRUNK_FOLD = Number(process.env.MEM_INDEX_FOLD) || 300;
// 卡里那一节能长多少：2026-10-06 砍完正文后实测 —— 私聊卡 4782/4800，**只剩 18 字余量**，
// 而"五"那节里固定头占 ~420 ⇒ 自动生成部分最多只能给 ~150。给 800 的话记忆一涨就顶破 4800。
// 想让卡上多留几条记忆：先砍正文/覆盖卡腾出空间，再抬这个数（HANDOFF 第十节第 10 条有账）。
export const BUDGET_CARD = Number(process.env.MEM_CARD_INDEX_CHARS) || 150;
export const CARD_RECENT = Number(process.env.MEM_CARD_RECENT) || 6;           // 卡上最多列几条最新记忆
const SUMMARY_CHARS = 60;
const OUR_MARKER = '<!-- 以下索引由 tools\\memory-index.mjs 从 memory\\记忆\\条目.jsonl 生成，别手改 -->';

// S 的初值口径（抄设计 §3.1：S0 = base[kind] × imp/3）
// ⚠️ 2026-10-06 13:2x 补：原来只有 4 个 kind，tool / fact 落进来 S 会是 null（沉降只能吃兜底值 7）。
// 口径与 tools\memory-sim.mjs 的 P.BASE_S 对齐；date 不衰减（s0 返回 null）。
export const S_BASE = { person: 21, meme: 10, event: 7, mood: 2, tool: 14, fact: 14 };
/** 枝别名（2026-10-23 加）：写条目时把新叶归到已有枝；检索（memory-get）也用同一张表。 */
export const BRANCH_ALIAS = {
  '插件与迁移': ['插件', '安装', '升级', '补丁', 'profile', 'bundle', '依赖', '挂载', 'junction', '卸载'],
  '插件瘦身': ['瘦身', '精简'],
  '记忆机制': ['记忆', '检索', '条目', '索引', '衰减', '枝', '干'],
  'DSH环境': ['环境', '沙箱', '路径', '权限', 'uac', '令牌'],
  '工具与网络': ['工具', '网络', '推送', '微信', 'fetch', '弹窗', 'vbs'],
  '跑步与赛事': ['跑步', '半马', '训练', '配速', '长距离', '跑', 'garmin', '手表'],
  '作息与习惯': ['作息', '睡眠', '睡觉', '熬夜', '习惯', '起床'],
  '网文': ['网文', '小说', '写书', '起点', '签约'],
  '宣传片': ['宣传片', '视频', '剪辑', '汇演'],
  '回退与事故': ['回退', '撤销', '事故', '崩溃', '回滚', '快照', '救援', '起不来'],
  '申请书至少': ['入党', '申请书', '面谈', '党章', '申请'],
  '能力与实践': ['能力', '实践', '练习', '画图'],
  '作业与画图': ['作业', '画法几何', '制图'],
  '记忆层间机制提案': ['提案', '层间'],
  'Jev': ['jev', '聊天助手'],
  '相处': ['相处', '反驳', '伙伴', 'mbti'],
  '转专业': ['转专业', '生物技术', '期末', '绩点'],
  'QQ线': ['qq', '群聊', '表情包', '小号', '鲸鲸'],
  'dsh-pet': ['桌宠', '宠物', 'dsh-pet'],
};
export const s0 = (kind, imp = 3) => {
  const base = S_BASE[kind];
  return base ? Number((base * (imp / 3)).toFixed(2)) : null;   // date 类不衰减
};

export const dedupKey = (s) => String(s ?? '').replace(/[\s，。、！？!?~～.…"'（）()「」【】:：;；]/g, '').slice(0, 40);

/** 字符二元组的 Jaccard —— 用来抓"同一件事的两种说法"（迁移留下的近似重复就靠它）。 */
const bigrams = (s) => {
  const t = String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
};
export function similar(a, b, threshold = 0.6) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter) >= threshold;
}

/** 去掉同义重复：从新到旧保留第一条，后面和它像的（同义/同内容）都丢掉。 */
export function dedupeSimilar(items) {
  const uniq = [];
  for (const r of items) if (!uniq.some((u) => similar(u.content, r.content))) uniq.push(r);
  return uniq;
}
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const day = (ts) => String(ts ?? '').slice(0, 10);

const readOr = (p, d = '') => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return d; } };

export function readLeaves(file = LEAVES) {
  return readOr(file).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 固定头 = 文件里第一个 `<!--` 之前的所有行（今天那份的第一个注释就是结算块标记）。 */
export function splitHead(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s*<!--/.test(l));
  const head = (i >= 0 ? lines.slice(0, i) : lines).join('\n').replace(/\s+$/, '');
  return { head, hadBlocks: i >= 0 };
}

/** 活着的叶：没过期、没被取代（**不分 visibility**）。 */
export function liveLeaves(leaves) {
  return leaves.filter((r) => r && !r.superseded_by && !r.valid_to);
}

/** 只留下能上卡的叶：活着的 + public。
 *  干.md 用的是 liveLeaves（含 private）—— 它只留本机、不往外发，
 *  私档本来就该在里面（否则我开场读干时看不见自己的私档）。 */
export function cardLeaves(leaves) {
  return liveLeaves(leaves).filter((r) => r.visibility === 'public');
}

/** 按枝聚合（同枝内按时间从新到旧；同内容/同义重复只留最新那条）。 */
export function groupBranches(leaves) {
  const byBranch = new Map();
  for (const r of leaves) {
    const br = r.parent || 'b-未归类';
    if (!byBranch.has(br)) byBranch.set(br, []);
    byBranch.get(br).push(r);
  }
  const out = [];
  for (const [branch, all] of byBranch) {
    const sorted = [...all].sort((a, b) => String(b.ts ?? b.created_at ?? '').localeCompare(String(a.ts ?? a.created_at ?? '')));
    const items = dedupeSimilar(sorted);
    out.push({
      branch,
      items,
      latest: day(items[0]?.ts),
      count: items.length,
      maxImp: Math.max(0, ...items.map((r) => Number(r.imp) || 0)),
    });
  }
  out.sort((a, b) => String(b.latest ?? '').localeCompare(String(a.latest ?? '')) || b.count - a.count);
  return out;
}

/** 每枝最多露几条叶（预算装不下会自动降，最低 1 条）。 */
export const LEAVES_PER_BRANCH = 3;

/** 一个枝里挑哪几条露出来：**重要度优先，其次新近度**（imp 字段终于用上了）。 */
export function pickLeaves(items, n) {
  return [...items]
    .sort((x, y) => (Number(y.imp) || 0) - (Number(x.imp) || 0)
      || String(y.ts ?? y.created_at ?? '').localeCompare(String(x.ts ?? x.created_at ?? '')))
    .slice(0, n);
}

/**
 * 渲染索引（2026-10-18 起：三段预算，**绝不静默丢枝**）。
 *   ① 常驻段（≈1100 字）：按"最新日期 → 最高 imp"排，每枝露 1~3 条摘要
 *   ② 折叠段（≈300 字）：装不下的枝**只留一行枝名 + 条数**，不丢
 *   ③ 兜底行：连枝名都装不下的才进"另外 N 枝"
 * 原则：**枝名是必需，摘要是奢侈品** —— 只省字数，不省可见性。
 */
export function renderIndex(branches, budget, tailNote = '完整索引见 node tools\\memory-get.mjs branches') {
  const ordered = [...branches].sort(
    (a, b) => String(b.latest ?? '').localeCompare(String(a.latest ?? '')) || (b.maxImp ?? 0) - (a.maxImp ?? 0),
  );
  const residentCap = Math.min(BUDGET_TRUNK_RESIDENT, Math.max(200, budget - BUDGET_TRUNK_FOLD - 40));
  const foldCap = Math.min(BUDGET_TRUNK_FOLD, Math.max(0, budget - residentCap - 40));

  // 常驻段：per 从 3 降到 1，取"能常驻最多枝"的那一档（同枝数时保留摘要更多的一档）
  const build = (per, cap) => {
    const lines = [];
    let used = 0;
    const taken = new Set();
    for (const b of ordered) {
      const block = [
        `- ${b.branch} ｜${b.count} 条 ｜最近 ${b.latest}`,
        ...pickLeaves(b.items, per).map((r) => `  · ${clip(String(r.content ?? ''), SUMMARY_CHARS)}`),
      ];
      const cost = block.join('\n').length + 1;
      if (used + cost > cap) break;
      lines.push(...block);
      used += cost;
      taken.add(b.branch);
    }
    return { lines, used, taken, per };
  };
  let resident = build(LEAVES_PER_BRANCH, residentCap);
  for (let per = LEAVES_PER_BRANCH - 1; per >= 1; per -= 1) {
    const t = build(per, residentCap);
    if (t.taken.size > resident.taken.size) resident = t;
  }

  // 折叠段：剩下的枝只留一行枝名（带条数 + 最近日期），保证"看得见"
  const rest = ordered.filter((b) => !resident.taken.has(b.branch));
  const foldLines = [];
  let foldUsed = 0;
  for (const b of rest) {
    const line = `- ${b.branch} ｜${b.count} 条 ｜最近 ${b.latest}（折叠）`;
    if (foldUsed + line.length + 1 > foldCap) break;
    foldLines.push(line);
    foldUsed += line.length + 1;
  }

  const assemble = () => {
    const hidden = rest.length - foldLines.length;
    const tail = hidden > 0 ? `- …另外 ${hidden} 枝没列出（${tailNote}）` : null;
    return { lines: [...resident.lines, ...foldLines, ...(tail ? [tail] : [])], hidden };
  };

  // 总预算兜底：从折叠段尾部删（绝不删常驻段）
  let out = assemble();
  while (out.lines.join('\n').length > budget && foldLines.length) {
    foldLines.pop();
    out = assemble();
  }
  return {
    lines: out.lines,
    used: out.lines.join('\n').length,
    cut: out.hidden,
    per: resident.per,
    resident: resident.taken.size,
    folded: foldLines.length,
  };
}

function stamp() { return new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-'); }

function backup(file) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(BACKUP_DIR, `${path.basename(file)}.bak-${stamp()}`));
    return true;
  } catch { return false; }
}

/** 卡里那一节：**最近 N 条 public 记忆**（保证"今天学到的"今晚就上卡）+ 一行枝索引兜底。 */
export function renderCard(leaves, branches, budget) {
  const lines = [];
  let used = 0;
  const indexLine = () => `- 索引（更老的枝）：${branches.map((b) => `${b.branch.replace(/^b-/, '')}(${b.count})`).join(' ｜ ')}`;
  const reserve = Math.min(90, indexLine().length + 1);      // 先给索引行占个座
  const recent = dedupeSimilar([...leaves].sort((a, b) => String(b.ts ?? b.created_at ?? '').localeCompare(String(a.ts ?? a.created_at ?? ''))));
  for (const r of recent) {
    if (lines.length >= CARD_RECENT) break;
    const line = `- ${day(r.ts ?? r.created_at)} ${clip(String(r.content ?? ''), 56)}`;
    if (used + line.length + 1 + reserve > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const idx = indexLine();
  if (used + idx.length + 1 <= budget) lines.push(idx);
  else if (budget - used > 24) lines.push(clip(idx, budget - used - 2));
  return { lines, used: lines.join('\n').length };
}

/** 主投影：给一份叶 + 固定头，产出两份文本（纯函数，自测就是测它）。 */
export function project(leaves, head) {
  const live = liveLeaves(leaves);        // 干：全部活叶（含 private）
  const pub = cardLeaves(leaves);         // 卡：只 public
  const trunkBranches = groupBranches(live);
  const cardBranches = groupBranches(pub);
  const full = renderIndex(trunkBranches, BUDGET_TRUNK);
  const card = renderCard(pub, cardBranches, BUDGET_CARD);
  const trunkText = [
    '# 干（索引）· 生成物，别手改',
    '',
    `> 由 tools\\memory-index.mjs 从 条目.jsonl 重建（活叶 ${live.length} 条 / ${trunkBranches.length} 枝，**含 private** —— 这份只留本机，不往外发）。`,
    '',
    ...full.lines,
    '',
  ].join('\n');
  const publicText = [head, '', OUR_MARKER, ...card.lines, ''].join('\n');
  return { trunkText, publicText, branches: trunkBranches, pubCount: pub.length, trunkChars: full.used, cardChars: card.used };
}

// ---------- 写锁（2026-10-23 加）：多进程同时改 条目.jsonl 会丢更新 ----------
// appendLeaves / touchLeaves 都是"读-改-写"；桌面线、微信线、插件定时器可能同时跑。
// 用同目录的 .lock 文件做互斥（'wx' 独占创建），等 3 秒；30 秒以上没释放的锁视为残锁，清掉重来。
// dry 模式不写盘、不拿锁（纯预览不阻塞别人）。
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 30000;
const leavesLockPath = () => `${LEAVES}.lock`;
function acquireLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const start = Date.now();
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
    } catch { /* 刚被释放，下一轮就能拿到 */ }
    if (Date.now() - start > timeoutMs) return false;
    Atomics.wait(sleepBuf, 0, 0, 40);
  }
}
function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* 已经没了就算了 */ }
}

// ---------- 写叶：两个写入者（结算 / QQ 记忆同步）共用这一个入口 ----------
/**
 * items: [{ text, kw?, kind?, imp?, visibility, ref? }]
 * 只负责"写叶"，不投影 —— 投影由调用方决定什么时候跑（writeProjection）。
 *
 * 2026-10-18 起多了"取代判定"（提案 ②，他选①：每轮顺手判）：
 *   · supersede=true 时，新叶若与**同枝**旧叶高度相似（默认 ≥0.8），旧叶标 valid_to + superseded_by
 *   · 只判同枝：跨枝的"像"多半是两件事碰巧用词近，模糊的不动
 *   · supersedes=[id] 可显式指定取代谁（比相似判定可靠，"更正"用这个）
 *   · 会改旧叶时先落 manifest 收据（可回滚），纯追加不落
 */
export function appendLeaves(items, opts = {}) {
  const dry = opts?.dry === true;
  if (dry) return appendLeavesUnlocked(items, opts);
  const lockPath = leavesLockPath();
  if (!acquireLock(lockPath)) {
    if (typeof opts?.log === 'function') opts.log(`写锁 ${LOCK_TIMEOUT_MS}ms 没拿到，这次不写（防丢更新）`);
    return { added: [], skipped: Array.isArray(items) ? items.length : 0, superseded: [], locked: false };
  }
  try {
    return appendLeavesUnlocked(items, opts);
  } finally {
    releaseLock(lockPath);
  }
}

function appendLeavesUnlocked(items, { log = console.log, dry = false, supersede = true, similarThreshold = 0.8, withinBranch = true, supersedes = [] } = {}) {
  const existing = readLeaves(LEAVES);
  const beforeText = readOr(LEAVES);
  const seen = new Set(existing.map((r) => dedupKey(r.content)));
  const branchNames = groupBranches(existing).map((b) => b.branch);
  const branchKw = new Map();
  for (const r of existing) {
    const b = r.parent;
    if (!b) continue;
    if (!branchKw.has(b)) branchKw.set(b, new Set());
    for (const k of r.kw ?? []) branchKw.get(b).add(String(k));
  }
  // 挂枝（先不搞聚类：枝名出现在正文里、或 kw 命中已有枝，就复用；否则新开一枝）
  // 2026-10-23 修：枝名里数字占比高的（b-02 / b-10-14 这种日期串误出的枝）不参与正文匹配，
  // 兜底新建枝时也不接受数字/日期串 —— 之前 "02" 会匹配所有含日期的正文，把 31 条吸进 b-02。
  // 2026-10-23 深夜再加「模糊归已有枝」：正文/kw 里出现枝名主干（中文前 2 字）就归过去，猜不中才新开，
  // 免得同主题每写一条就裂一个新枝。
  const badBranchName = (s) => {
    const t = String(s ?? '').trim();
    if (t.length < 2) return true;
    return (t.match(/\d/g) || []).length / t.length > 0.4;
  };
  const pickBranch = (kws, text) => {
    const textL = String(text ?? '').toLowerCase();
    const kwText = (kws || []).join(' ').toLowerCase();
    // ① 正文里出现完整枝名主干
    for (const b of branchNames) { const bare = b.replace(/^b-/, ''); if (!badBranchName(bare) && textL.includes(bare.toLowerCase())) return b; }
    // ② kw 精确命中已有枝的 kw 池
    for (const k of kws) for (const [b, set] of branchKw) if (set.has(k)) return b;
    // ③ 模糊：正文/kw 命中枝名或别名（≥2 字）→ 得分最高的已有枝
    let best = null, bestScore = 0;
    for (const b of branchNames) {
      const bare = String(b).replace(/^b-/, '');
      if (badBranchName(bare)) continue;
      const keys = [bare, ...(BRANCH_ALIAS[bare] ?? [])];
      let score = 0;
      for (const k of keys) {
        const kl = String(k).toLowerCase();
        if (kl.length < 2) continue;
        if (textL.includes(kl)) score += 2;
        if (kwText.includes(kl)) score += 1.5;
      }
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best && bestScore >= 2) return best;
    // ④ 猜不中才新开
    const kwPick = (kws || []).find((k) => !badBranchName(k));
    const textPick = String(text ?? '').replace(/\s+/g, '').slice(0, 6);
    return `b-${kwPick || (badBranchName(textPick) ? '杂' : textPick)}`;
  };
  const nowIso = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  const dayTag = nowIso.slice(0, 10).replace(/-/g, '');
  // id 前缀区分来源（设计 §2.1）：q = QQ 侧（备忘录/同步写进来的），h = 宿主侧（我手写）
  let seqQ = existing.filter((r) => String(r.id).startsWith(`q-${dayTag}-`)).length;
  let seqH = existing.filter((r) => String(r.id).startsWith(`h-${dayTag}-`)).length;
  const added = [];
  let skipped = 0;
  for (const it of items) {
    const text = String(it?.text ?? '').trim();
    if (!text) continue;
    if (seen.has(dedupKey(text))) { skipped += 1; continue; }
    const side = it.side === 'h' ? 'h' : 'q';
    const seq = side === 'h' ? (seqH += 1) : (seqQ += 1);
    const kind = it.kind ?? 'event';
    const imp = Number(it.imp) || 3;
    const kw = (it.kw ?? []).map(String).filter(Boolean).slice(0, 4);
    const parent = it.parent || pickBranch(kw, text);
    added.push({
      id: `${side}-${dayTag}-${String(seq).padStart(3, '0')}`,
      ts: nowIso,
      created_at: nowIso,
      kind,
      imp,
      visibility: it.visibility === 'public' ? 'public' : 'private',
      content: text,
      kw,
      ref: it.ref ?? 'tools/qq-bridge/state/qq-memo.jsonl',
      parent,
      // ---- v3 卡片字段（2026-11-08）----
      path: [parent],
      title: it.title || makeTitle(text),
      box: 0,
      links: [],
      trust: 0,
      replaces: [],
      // 证据链（2026-11-08）：how = told/observed/inferred/file，evidence = 原话或片段
      provenance: it.provenance || { how: 'unknown', evidence: '', ref: it.ref ?? 'manual:host' },
      access: [nowSec],
      reps: 0,
      S: s0(kind, imp),
      D: 5,
      valid_from: nowIso,
      valid_to: null,
      superseded_by: null,
      state: 'L1',
    });
    seen.add(dedupKey(text));
  }

  // ---- 取代判定（2026-10-18）----
  const superseded = [];
  // v3 冲突/版本（2026-11-08）：旧条不删，留 replace 链 —— 新条记「我取代了谁」，旧条记「被谁取代、为什么」
  const markOld = (r, byId, reason, target) => {
    if (!r || r.superseded_by || r.valid_to || r.state === 'pinned') return;
    r.valid_to = nowIso;
    r.superseded_by = byId;
    if (reason) r.superseded_reason = reason;
    if (target) {
      if (!Array.isArray(target.replaces)) target.replaces = [];
      if (!target.replaces.includes(r.id)) target.replaces.push(r.id);
    }
    superseded.push({ id: r.id, by: byId, reason: reason || '' });
  };
  for (const a of added) {
    // ① 手动指定（--supersedes <id>）：最可靠
    for (const id of supersedes ?? []) {
      const r = existing.find((x) => String(x.id) === String(id));
      if (r) markOld(r, a.id, 'manual', a);
    }
    // ② 自动：同枝 + 高度相似（默认 ≥0.8）
    if (!supersede) continue;
    for (const r of existing) {
      if (!r || r.superseded_by || r.valid_to || r.state === 'pinned') continue;
      if (withinBranch && (r.parent ?? 'b-未归类') !== a.parent) continue;
      if (!similar(r.content, a.content, similarThreshold)) continue;
      markOld(r, a.id, 'auto-similar', a);
    }
  }

  if (added.length && !dry) {
    if (superseded.length) {
      const afterText = existing.concat(added).map((r) => JSON.stringify(r)).join('\n') + '\n';
      writeManifest({ actor: 'memory-add', action: 'add', files: [{ path: LEAVES, before: beforeText, after: afterText }] });
      fs.writeFileSync(LEAVES, afterText, 'utf8');
    } else {
      fs.appendFileSync(LEAVES, added.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
  }
  const pubN = added.filter((r) => r.visibility === 'public').length;
  const supNote = superseded.length ? `；取代旧条 ${superseded.length}（${superseded.map((s) => s.id).join(', ')}）` : '';
  log(`叶 +${added.length} 条 → memory\\记忆\\条目.jsonl（公开 ${pubN} / 私档 ${added.length - pubN}${skipped ? `；与已有重复跳过 ${skipped}` : ''}${supNote}）${dry ? '（dry）' : ''}`);
  return { added, skipped, superseded };
}

// ---------- 回写：叶被"用到"时记一次（闭环里缺的那半） ----------
// 为什么要有它：appendLeaves 只在"落一条新叶"那一刻写 access，我后来**读到**某条叶是不会回写的
// ⇒ 效应器（memory-decay）只看得到"写下来那一刻"，于是"被用到就回 L1"这条回路是空的。
// 这里把那一半补上：取用 → access 记一次 → 距上次变 0 → 下次沉降自然把它拉回 L1。
//
// 三条口径（都是为了不抖、不爆）：
//   · 死区：同一条 10 分钟内重复取用只记一次（一次会话里我可能把同一份读好几遍）
//   · 截断：access 只留最近 32 次（ACT-R 的 Σ t^(-0.5) 里，很老的值贡献趋近 0）
//   · 保护：pinned / 已被取代 / 已过期的叶 —— 记 access，但**不改 state**（别把死掉的叶救活）
export const TOUCH_GAP_SEC = Number(process.env.MEM_TOUCH_GAP_SEC) || 600;
export const ACCESS_KEEP = Number(process.env.MEM_ACCESS_KEEP) || 32;
// 复习增益（2026-11-11 晚）：翻一次 S ×S_GAIN，封顶 S_CAP 天 —— 常翻的沉得慢，但不是金刚不坏。
export const S_GAIN = Number(process.env.MEM_S_GAIN) || 1.3;
export const S_CAP = Number(process.env.MEM_S_CAP) || 90;

/** 纯函数：算"被取用后这批叶长什么样"。只动 access / reps / state，其余字段逐字不动。 */
export function planTouch(leaves, ids, { now = Date.now(), gapSec = TOUCH_GAP_SEC, keep = ACCESS_KEEP } = {}) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean));
  const nowSec = Math.floor(now / 1000);
  const changed = [];
  const skipped = [];
  const next = leaves.map((r) => {
    if (!want.has(String(r?.id))) return r;
    const acc = (Array.isArray(r.access) ? r.access : []).map(Number).filter(Number.isFinite);
    const last = acc.length ? Math.max(...acc) : 0;
    if (last && nowSec - last < gapSec) { skipped.push({ id: r.id, gap: nowSec - last }); return r; }
    const frozen = r.state === 'pinned' || Boolean(r.superseded_by) || Boolean(r.valid_to);
    const out = { ...r, access: [...acc, nowSec].slice(-keep), reps: (Number(r.reps) || 0) + 1 };
    if (!frozen) {
      // 复习增益（2026-11-11 晚加）：被翻一次，S 涨一截（封顶 S_CAP）——翻得多的沉得慢。
      // 这是 memory-decay-sim 里记了很久的"坑 2：S 从没被复习更新过"。
      const sNow = Number(r.S) > 0 ? Number(r.S) : 7;
      out.S = Math.round(Math.min(S_CAP, sNow * S_GAIN) * 100) / 100;
      // 翻卡回浅（2026-11-11 晚加）：一次回一档；深/沉底要最近 30 天翻够 3 次才回得来。
      out.box = planBoxOnTouch(out, now);
      // 合并后（2026-11-11 深夜）：盒子是真相，state 只是它的投影。
      out.state = stateOfBox(out.box);
    }
    changed.push({
      id: r.id, from: r.state ?? 'L1', to: out.state, reps: out.reps, frozen, n: out.access.length,
      boxFrom: Math.max(0, Math.min(4, Number(r.box) || 0)), boxTo: out.box,
    });
    return out;
  });
  const missing = [...want].filter((id) => !leaves.some((r) => String(r?.id) === id));
  return { next, changed, skipped, missing };
}

/** 每天只留一份备份（回写比沉降频繁得多，按秒备份会把归档撑爆）。 */
function backupDaily(file, tag = '条目.jsonl') {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `${tag}.bak-${new Date().toLocaleDateString('sv-SE')}`);
    if (!fs.existsSync(dest) && fs.existsSync(file)) fs.copyFileSync(file, dest);
    return true;
  } catch { return false; }
}

// 生产文件的正身（不随 MEM_LEAVES 变）：只有写它才值得留每日备份 ——
// 跑夹具测试（MEM_LEAVES 指向副本）时别去污染 归档流水。
const CANON_LEAVES = path.join(HOME, 'memory', '记忆', '条目.jsonl');

/** 原子写：先写临时文件再 rename（同盘 rename 原子，别让并发的读拿到半行）。 */
export function writeLeavesFile(leaves, { file = LEAVES, dry = false, backupFirst = true } = {}) {
  const text = leaves.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (dry) return { ok: true, wrote: false, text };
  if (backupFirst && path.resolve(file) === path.resolve(CANON_LEAVES)) backupDaily(file);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, wrote: true, text };
}

/**
 * 生产入口：取用时回写。**自己重读一遍再改** —— 别拿调用方启动时的旧快照去覆盖
 * 别人（结算 / QQ 同步）刚追加进来的叶。窗口小到可以忽略，但不是零。
 */
export function touchLeaves(ids, opts = {}) {
  const dry = opts?.dry === true;
  if (dry) return touchLeavesUnlocked(ids, opts);
  const lockPath = leavesLockPath();
  if (!acquireLock(lockPath)) {
    return { changed: [], skipped: [], missing: Array.isArray(ids) ? ids : [ids], locked: false };
  }
  try {
    return touchLeavesUnlocked(ids, opts);
  } finally {
    releaseLock(lockPath);
  }
}

function touchLeavesUnlocked(ids, { now = Date.now(), dry = false, gapSec = TOUCH_GAP_SEC, log = null } = {}) {
  const plan = planTouch(readLeaves(), ids, { now, gapSec });
  if (plan.changed.length && !dry) writeLeavesFile(plan.next);
  if (log) log(plan);
  return plan;
}

export async function writeProjection({ dry = false, log = console.log } = {}) {
  // 2026-10-07: this used to write 干.md and docs\qq-可公开记忆.md together, and it
  // used the QQ file's fixed header as a fail-closed precondition for both. That
  // made the QQ file a hard dependency of my own index: once it was gone, 干.md
  // silently stopped updating. The two are now independent -- 干.md always gets
  // written, and the card projection only runs when MEM_PUBLIC_ON=1 and its own
  // header is present.
  const publicOn = process.env.MEM_PUBLIC_ON === '1';
  const leaves = readLeaves();

  // --- projection A: my own index. No dependency on anything external. ---
  const trunkP = project(leaves, readOr(TRUNK));
  if (!dry) {
    backup(TRUNK);
    fs.writeFileSync(TRUNK, trunkP.trunkText, 'utf8');
    if (readOr(TRUNK).replace(/\s+$/, '') !== trunkP.trunkText.replace(/\s+$/, '')) {
      log('✖ 干.md 写完复核不一致！');
      return { ok: false };
    }
  }
  log(`投影：干 ${trunkP.trunkChars}/${BUDGET_TRUNK} 字（${trunkP.branches.length} 枝）`);

  // --- projection B: the card section. Off unless asked for. ---
  let cardInfo = null;
  if (publicOn) {
    const { head, hadBlocks } = splitHead(readOr(PUBLIC_MEM));
    if (head.length < 100 || !head.includes('规矩')) {
      log('✖ 卡投影：固定头认不出来（或太短），只跳这一份，干.md 已正常更新');
    } else {
      const p = project(leaves, head);
      if (!dry) {
        backup(PUBLIC_MEM);
        fs.writeFileSync(PUBLIC_MEM, p.publicText, 'utf8');
        if (readOr(PUBLIC_MEM).replace(/\s+$/, '') !== p.publicText.replace(/\s+$/, '')) {
          log('✖ 卡投影写完复核不一致！');
          return { ok: false };
        }
        log(`✔ 已写 docs\\qq-可公开记忆.md（改前备了份）；旧结算块标记${hadBlocks ? '已并入条目流' : '本来就没有'}`);
      }
      cardInfo = { pubCount: p.pubCount, cardChars: p.cardChars };
    }
  }
  if (dry) log('（dry：没写盘）');

  // --- projection C: 连线 + 卡片盒（目录/枝页/沉底）—— 2026-11-08 接进闭环 ---
  // 动态 import：这两个都反过来要读本文件定义的路径/函数（或读同一份数据），静态 import 会成环。
  let linksInfo = null;
  let tree = null;
  if (!dry) {
    try {
      const { runLinks } = await import('./memory-links.mjs');
      linksInfo = runLinks({ dry: false });
      log(`连线：${linksInfo.withLinks}/${linksInfo.total} 条有连`);
    } catch (e) {
      log('✖ 连线失败（不影响其它）：' + (e?.message ?? e));
    }
    try {
      const { generate } = await import('./memory-tree.mjs');
      tree = generate({ dry: false });
      log(`卡片盒：目录 ${tree.dirChars} 字 / ${tree.branches} 枝 / 新${tree.boxes[0]} 浅${tree.boxes[1]} 中${tree.boxes[2]} 深${tree.boxes[3]} 沉底${tree.boxes[4]}`);
    } catch (e) {
      log('✖ 卡片盒生成失败（不影响干.md）：' + (e?.message ?? e));
    }
  }

  return { ok: true, ...trunkP, publicOn, card: cardInfo, tree, links: linksInfo };
}

// ---------- 自测：只测纯函数，不碰生产文件 ----------
function selftest() {
  const head = '# 头\n\n> 规矩：这里只写群里说出来也不出事的东西，宿主的身份一律不写。\n\n## 关于我自己\n\n- 我是小鲸鱼\n';
  const leaf = (id, vis, parent, content, ts, kw = ['梗']) => ({ id, visibility: vis, parent, content, ts, kw, kind: 'event' });
  const leaves = [
    leaf('q-1', 'public', 'b-event', '在愿仁积被51号病人逗了半天', '2026-10-06T10:00:00.000Z'),
    leaf('q-2', 'public', 'b-event', '在愿仁积被51号病人逗了半天', '2026-10-06T11:00:00.000Z'),   // 同内容重复
    leaf('q-3', 'private', 'b-宿主', '宿主的作息是三点睡', '2026-10-06T12:00:00.000Z'),
    { id: 'q-4', visibility: 'public', parent: 'b-旧', content: '这条已被取代', ts: '2026-10-05T00:00:00.000Z', superseded_by: 'q-5', kw: [] },
  ];
  const p = project(leaves, head);
  const pubOnly = !p.publicText.includes('三点睡');            // 私档不上卡
  const trunkHasPrivate = p.trunkText.includes('三点睡');      // 但干（本机索引）要含私档
  // p.branches 现在是「干」的分组（含 private 枝 b-宿主），所以挑 b-event 那条来断言
  const evBranch = p.branches.find((b) => b.branch === 'b-event');
  const deduped = evBranch?.count === 1 && evBranch.items[0].id === 'q-2';
  const supersededGone = !p.trunkText.includes('已被取代');
  const headKept = p.publicText.startsWith(head);
  const budgetOk = p.cardChars <= BUDGET_CARD && p.trunkChars <= BUDGET_TRUNK;
  const split = splitHead('# h\n\n> 规矩\n\n<!-- 2026-10-06 结算 -->\n- x\n');

  const manyLeaves = Array.from({ length: 60 }, (_, i) => leaf(`q-${i}`, 'public', `b-枝${i}`, `第 ${i} 条够长够长够长的记忆内容，用来把预算顶满看看会不会溢出来`, `2026-10-0${(i % 9) + 1}T10:00:00.000Z`));
  const q = project(manyLeaves, head);
  const cardLines = (q.publicText.split(OUR_MARKER)[1] ?? '').split('\n').filter((l) => l.trim().startsWith('- '));
  const cases = [
    ['1 私档不上卡（零泄漏）', pubOnly],
    ['1b 干里含私档（完整索引；干只留本机，不外发）', trunkHasPrivate],
    ['2 同枝同内容去重、留最新那条', deduped],
    ['3 被取代(superseded)的不进索引', supersededGone],
    ['4 固定头逐字保留', headKept],
    ['5 两份都没超预算', budgetOk],
    ['6 固定头切分正确', split.head.includes('规矩') && !split.head.includes('结算')],
    [`7 塞 60 条后卡那节仍在 ${BUDGET_CARD} 内、行数受控（实测 ${q.cardChars} 字 / ${cardLines.length} 行 / 干 ${q.trunkChars} 字）`, q.cardChars <= BUDGET_CARD && cardLines.length <= CARD_RECENT + 1],
    [`8 最新那条 public 叶一定在卡上（首行：${String(cardLines[0] ?? '').slice(0, 26)}）`, cardLines[0]?.includes('第 ') === true],
    [`9 干：枝头行 + 缩进叶行，每枝叶数 ≤ ${LEAVES_PER_BRANCH}（实测 ${q.trunkText.split('\n').filter((l) => l.trim().startsWith('· ')).length} 条叶 / ${q.trunkText.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- …')).length} 枝）`, (() => {
      const heads9 = q.trunkText.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- …'));
      const leaves9 = q.trunkText.split('\n').filter((l) => l.trim().startsWith('· '));
      return heads9.length <= 60 && leaves9.length <= heads9.length * LEAVES_PER_BRANCH;
    })()],
    ['10 近似重复（同一件事两种说法）只留一条', (() => {
      const dup = [
        leaf('q-a', 'public', 'b-ev', '今天在愿仁积那边被 51号病人逗了半天，他自称我老大，我说他是假冒的，笑死', '2026-10-06T11:00:00.000Z'),
        leaf('q-b', 'public', 'b-ev', '在愿仁积被51号病人逗了半天，他自称我老大，我说他是假冒的，笑死', '2026-10-06T10:00:00.000Z'),
      ];
      const z = project(dup, head);
      const rows = (z.publicText.split(OUR_MARKER)[1] ?? '').split('\n').filter((l) => l.trim().startsWith('- 2026'));
      return rows.length === 1 && z.branches[0].count === 1;
    })()],
    // ---- 回写（取用 → access，2026-10-06 补的闭环）----
    ['11 回写只动 access/reps/state/S/box（其余字段逐字不动）', (() => {
      const before = { ...leaf('q-t1', 'public', 'b-梗', '取用回写的夹具', '2026-10-06T10:00:00.000Z'), access: [1000], reps: 2, S: 7, state: 'cold' };
      const { next, changed } = planTouch([before], ['q-t1'], { now: 2000 * 1000 });
      const after = next[0];
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
      const diffs = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort().join(',');
      return changed.length === 1 && diffs === 'S,access,box,reps,state'
        && after.access.join(',') === '1000,2000' && after.reps === 3 && after.state === 'L1' && after.box === 0;
    })()],
    ['12 死区：10 分钟内重复取用不写（不抖）', (() => {
      const l = { ...leaf('q-t2', 'public', 'b-梗', '死区夹具', '2026-10-06T10:00:00.000Z'), access: [2000], reps: 1, state: 'L1' };
      const p = planTouch([l], ['q-t2'], { now: 2000 * 1000 + 60 * 1000 });
      return p.changed.length === 0 && p.skipped.length === 1 && p.next[0].reps === 1;
    })()],
    ['13 保护：pinned / 已取代的记 access 但不改 state', (() => {
      const pin = { ...leaf('q-t3', 'public', 'b-梗', '钉住的', '2026-10-06T10:00:00.000Z'), access: [1000], state: 'pinned' };
      const sup = { ...leaf('q-t4', 'public', 'b-梗', '被取代的', '2026-10-06T10:00:00.000Z'), access: [1000], state: 'cold', superseded_by: 'q-9' };
      const p = planTouch([pin, sup], ['q-t3', 'q-t4'], { now: 5000 * 1000 });
      return p.changed.length === 2 && p.next[0].state === 'pinned' && p.next[1].state === 'cold' && p.next[1].reps === 1;
    })()],
    ['14 access 截断到最近 32 次（不无限涨）', (() => {
      const many = { ...leaf('q-t5', 'public', 'b-梗', '截断夹具', '2026-10-06T10:00:00.000Z'), access: Array.from({ length: 40 }, (_, i) => 100 + i) };
      const p = planTouch([many], ['q-t5'], { now: 9999 * 1000, keep: 32 });
      return p.next[0].access.length === 32 && p.next[0].access[31] === 9999 && p.next[0].access[0] === 109;
    })()],
  ];
  for (const [name, ok] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const allOk = cases.every(([, ok]) => ok);
  console.log(allOk ? '=== memory-index 自测全部通过 ===' : '=== memory-index 自测有失败项 ===');
  process.exit(allOk ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
if (process.argv.includes('--list')) {
  // 条目流现状（id ｜ 枝 ｜ 重要度 ｜ 摘要）—— 归并枝、写裁决表时看它。
  for (const r of readLeaves()) {
    console.log(`${r.id} ｜ ${r.parent ?? '（无枝）'} ｜ imp${r.imp ?? '?'} ｜ ${String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 58)}`);
  }
  process.exit(0);
}
if (process.argv.includes('--print')) {
  const p = project(readLeaves(), splitHead(readOr(PUBLIC_MEM)).head);
  console.log('--- 干（完整版）---'); console.log(p.trunkText);
  console.log('--- 卡里那一节（卡内版）---'); console.log(p.publicText);
  process.exit(0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await writeProjection({ dry: process.argv.includes('--dry') });
}
