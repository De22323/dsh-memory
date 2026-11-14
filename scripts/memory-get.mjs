// memory-get.mjs -- 按 id / 关键词取记忆，**只回一行**，不整读文件（设计 §五 的读取协议）。
//
// 为什么要有它：以前的读法是"整份读某个 md"，一份 3600 字；现在是"索引 + 1~3 条叶"（~600 字）。
// 它只看 条目.jsonl（唯一真相），不碰任何投影。
//
// **取用 = 回写**（2026-10-06 修的闭环）：get 到一条 = 我真的用到了它 ⇒ 顺手把这条的 access 记一次，
// 于是"距上次被碰"归零、下次沉降自然把它拉回 L1。只看见列表（search/branches）**不算**用到 ——
// 想标"我提到了它"就显式 touch。回写只动 access/reps/state 三个字段，不碰正文，也不触发投影。
//
// 用法：
//   node tools\memory-get.mjs get <id>           取一条（≤120 字 + 出处）；默认顺手回写 access
//   node tools\memory-get.mjs get <id> --no-touch  取，但不回写（只是核对一眼时用）
//   node tools\memory-get.mjs search <词> [--n 5] [--touch] 搜：kw/正文命中，只回 id + 一句话
//   node tools\memory-get.mjs touch <id> [id…]   只记"我用到过这条"（没取全文、只是提到了）
//   node tools\memory-get.mjs branches            列枝（枝名 ｜ 几条 ｜ 最新 ｜ 一条摘要）
//   node tools\memory-get.mjs branch <枝名>       某枝的成员清单（不展开正文）
//   node tools\memory-get.mjs stats               体检：叶数 / 可见性 / 分级 / 索引占用

import fs from 'node:fs';
import path from 'node:path';
import { readLeaves, groupBranches, touchLeaves, TRUNK, PUBLIC_MEM } from './memory-index.mjs';
import { searchLeaves } from './lib/memory-search.mjs';
import { makeTitle, DIR_FILE, BRANCH_DIR, generate, HOME } from './memory-tree.mjs';

const LEAVES_FILE = path.join(HOME, 'memory', '记忆', '条目.jsonl');

/** 翻卡回浅现在统一在 planTouch 里做（2026-11-11 晚）：一次回一档、深层要 30 天内翻够 3 次。
 *  这里只负责"翻完卡刷一下目录/枝页"。 */
const refreshTree = () => { try { generate({ dry: false }); } catch { /* 静默 */ } };

/** 盒位变化的说明（没有变化就空串）。 */
const boxNote = (t) => (t.changed || [])
  .filter((c) => c.boxFrom !== undefined && c.boxTo !== undefined && c.boxFrom !== c.boxTo)
  .map((c) => `b${c.boxFrom}→b${c.boxTo}`)
  .join(' ｜ ');

/** 超深层归档（2026-11-11 深夜）：正文搬去 归档-旧版本与记录\超深层\，这里把它捞回来。 */
function readArchived(r) {
  try {
    const p = path.isAbsolute(r.archived.file) ? r.archived.file : path.join(HOME, r.archived.file);
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (String(o.id) === String(r.id)) return String(o.content ?? '');
    }
  } catch { /* 归档文件丢了就退回存根 */ }
  return r.content;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const readOr = (p, d = '') => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return d; } };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; };
const vis = (r) => (r.visibility === 'public' ? '公' : '私');
const when = (r) => String(r.ts ?? r.created_at ?? '').slice(0, 10);
const leaves = readLeaves();

// ── 负反馈（2026-10-23 接上）：search 零命中时记一条 miss，供以后衰减/调权重用。
// 只记 miss，不记 hit —— 命中是常态，刷进去只会把文件撑大。
const ROOT = path.dirname(path.dirname(import.meta.filename));
const FEEDBACK_FILE = path.join(ROOT, 'runtime', 'memory-feedback.jsonl');
const logMiss = (query) => {
  try {
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify({ ts: new Date().toISOString(), type: 'miss', query: String(query) }) + '\n');
  } catch { /* 记不上就算了 */ }
};

if (!cmd || cmd === 'help') {
  console.log(readOr(import.meta.filename).split('\n').filter((l) => l.startsWith('//   node')).map((l) => l.slice(5)).join('\n'));
  process.exit(0);
}

if (cmd === 'get') {
  const id = argv[1];
  const r = leaves.find((x) => String(x.id) === String(id));
  if (!r) { console.log(`没有 id=${id} 这条`); process.exit(1); }
  console.log(`${r.id} [${vis(r)}｜${r.kind}｜${r.state ?? '-'}｜${when(r)}]`);
  const fullText = r.archived ? readArchived(r) : r.content;
  console.log(clip(fullText, r.archived ? 240 : 120));
  if (r.archived) console.log(`〔正文在归档：${String(r.archived.file).replace(HOME + path.sep, '')}〕`);
  const t = argv.includes('--no-touch') ? { changed: [], skipped: [] } : touchLeaves([id]);
  if (t.changed?.length) refreshTree();
  const mark = t.changed.length ? ' ｜已记 access' : (t.skipped.length ? ' ｜死区内，10 分钟内刚记过' : '');
  const bx = t.changed?.length ? boxNote(t) : '';
  const HOW = { told: '他说的', observed: '看到/跑出来的', inferred: '我推的', file: '文件里的', unknown: '来源没记' };
  const pv = r.provenance || {};
  const provLine = pv.how || r.ref
    ? `来源：${HOW[pv.how] || pv.how || (r.ref || '没记')}${pv.evidence ? ` ｜「${String(pv.evidence).slice(0, 80)}」` : ''}${r.trust < 0 ? ' ｜⚠ 他否过' : r.trust > 0 ? ' ｜✓ 他确认过' : ''}`
    : null;
  console.log(`枝 ${r.parent || '-'}${r.superseded_by ? ` ｜ 已被 ${r.superseded_by} 取代` : ''}${mark}${bx ? ` ｜ 盒 ${bx}` : ''}`);
  if (provLine) console.log(provLine);
  const linked = (Array.isArray(r.links) ? r.links : []).map((id) => leaves.find((x) => String(x.id) === String(id))).filter(Boolean);
  if (linked.length) console.log(`相关：${linked.map((x) => `${x.id} ${makeTitle(x)}`).join(' ｜ ')}`);
  const olds = (Array.isArray(r.replaces) ? r.replaces : []).map((id) => leaves.find((x) => String(x.id) === String(id))).filter(Boolean);
  if (olds.length) console.log(`更正了：${olds.map((x) => `${x.id} ${makeTitle(x)}`).join(' ｜ ')}`);
  if (r.superseded_by) {
    const newer = leaves.find((x) => String(x.id) === String(r.superseded_by));
    console.log(`已被取代：${r.superseded_by} ${newer ? makeTitle(newer) : ''}${r.superseded_reason ? `（${r.superseded_reason}）` : ''}`);
  }
  process.exit(0);
}

if (cmd === 'touch') {
  const ids = argv.slice(1).filter((a) => a && !a.startsWith('--'));
  if (!ids.length) { console.log('用法：touch <id> [id…]   把"我用到了这几条"记一次 access'); process.exit(1); }
  const t = touchLeaves(ids);
  const back = t.changed.filter((c) => c.to !== c.from).map((c) => `${c.id} ${c.from}→${c.to}`);
  const bx = boxNote(t);
  console.log(`记了 ${t.changed.length} 条 access${t.skipped.length ? `；${t.skipped.length} 条在死区内` : ''}${t.missing.length ? `；没有 ${t.missing.join(',')} 这条` : ''}`);
  if (back.length) console.log(`顺带回 L1：${back.join(' ｜ ')}`);
  if (bx) console.log(`盒位回升：${bx}`);
  process.exit(0);
}

if (cmd === 'search') {
  const q = argv[1];
  if (!q) { console.log('用法：search <词> [--n 5] [--touch] [--json] [--all]'); process.exit(1); }
  const n = Number(flag('--n', 5)) || 5;
  // 检索准入（2026-11-08）：
  //   · 默认（软）：被取代/过期的**不进**结果；trust=-1 的仍然进（降权 + 标 ⚠）
  //   · --strict（或 MEM_STRICT=1）：他否过的也不进
  //   · --all：连被取代的也看（查历史用）
  const strict = argv.includes('--strict') || process.env.MEM_STRICT === '1';
  const pool = (argv.includes('--all') ? leaves : leaves.filter((r) => !r.superseded_by && !r.valid_to))
    .filter((r) => !strict || Number(r.trust) >= 0);
  const picked = searchLeaves(pool, q, { n });
  if (!picked.length) {
    logMiss(q); // 零命中 = 想不起来，记进负反馈
    console.log(`没有命中「${q}」的叶（共 ${pool.length} 条活着${argv.includes('--all') ? '' : '；想看死条目加 --all'}）`);
    process.exit(0);
  }
  const badge = (r) => {
    const marks = [`b${Number(r.box) || 0}`];
    const opens = Math.max(0, (Array.isArray(r.access) ? r.access.length : 0) - 1);
    if (opens) marks.push(`翻${opens}次`);
    if (Number(r.trust) < 0) marks.push('⚠他否过');
    else if (Number(r.trust) > 0) marks.push('✓确认过');
    return marks.join('·');
  };
  if (argv.includes('--json')) {
    console.log(JSON.stringify(picked.map(({ r, s }) => ({
      id: r.id, score: Number(s.toFixed(2)), branch: r.parent || '', date: when(r), content: clip(r.content, 120),
    }))));
  } else {
    console.log(`「${q}」命中 ${picked.length} 条（只给标题；要正文用 memory_get <id>）：`);
    for (const { r, s } of picked) console.log(`  ${r.parent || '-'} › ${makeTitle(r)}   ${r.id}  [${vis(r)}/${s.toFixed(1)} · ${badge(r)}]`);
  }
  // --touch：这一批我确实要用（默认不记 —— 只看见列表不算"用到"）
  if (argv.includes('--touch')) {
    const t = touchLeaves(picked.map((h) => h.r.id));
    console.log(`（--touch：记了 ${t.changed.length} 条 access${t.skipped.length ? `，${t.skipped.length} 条在死区内` : ''}）`);
  }
  process.exit(0);
}

if (cmd === 'tree') {
  const name = argv[1];
  if (!name) {
    console.log(readOr(DIR_FILE) || '（目录还没生成：跑 node tools\\memory-tree.mjs）');
    process.exit(0);
  }
  let files = [];
  try { files = fs.readdirSync(BRANCH_DIR).filter((f) => f.endsWith('.md')); } catch { /* 没目录 */ }
  const hit = files.find((f) => f === `${name}.md`) || files.find((f) => f.includes(name));
  if (!hit) { console.log(`没有匹配「${name}」的枝页（跑 node tools\\memory-tree.mjs 重新生成）`); process.exit(1); }
  console.log(readOr(path.join(BRANCH_DIR, hit)));
  process.exit(0);
}

if (cmd === 'branches') {
  const bs = groupBranches(leaves);
  console.log(`共 ${bs.length} 枝 / ${leaves.length} 叶：`);
  for (const b of bs) console.log(`  ${b.branch} ｜${b.count} 条 ｜${b.latest} ｜${clip(b.items[0]?.content, 50)}`);
  process.exit(0);
}

if (cmd === 'branch') {
  const name = argv[1];
  const bs = groupBranches(leaves).filter((b) => b.branch === name || (name && b.branch.includes(name)));
  if (!bs.length) { console.log(`没有匹配「${name}」的枝`); process.exit(1); }
  for (const b of bs) {
    console.log(`${b.branch} ｜${b.count} 条 ｜最新 ${b.latest}`);
    for (const r of b.items) console.log(`  ${r.id} [${vis(r)}] ${clip(r.content, 60)}`);
  }
  process.exit(0);
}

if (cmd === 'history') {
  const id = argv[1];
  if (!id) { console.log('用法：history <id>   看这条记忆的版本链'); process.exit(1); }
  let rows = [];
  try { rows = fs.readFileSync(LEAVES_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { /* ignore */ }
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const cur = byId.get(String(id));
  if (!cur) { console.log(`没有 id=${id} 这条`); process.exit(1); }
  const line = (r) => `${r.id}  ${when(r)}  ${makeTitle(r)}${r.superseded_by ? `  →被 ${r.superseded_by}` : ''}`;
  console.log(line(cur));
  // 往上：它取代了谁（再往上的线也一起走两层）
  const up = [];
  const walkUp = (r, depth) => {
    for (const pid of Array.isArray(r.replaces) ? r.replaces : []) {
      const p = byId.get(String(pid));
      if (!p) continue;
      up.push({ r: p, depth });
      if (depth < 2) walkUp(p, depth + 1);
    }
  };
  walkUp(cur, 1);
  if (up.length) { console.log('更早的版本：'); for (const { r, depth } of up) console.log(`  ${'  '.repeat(depth - 1)}${line(r)}`); }
  // 往下：谁取代了它
  const down = [];
  const walkDown = (r, depth) => {
    if (!r.superseded_by) return;
    const n = byId.get(String(r.superseded_by));
    if (!n) return;
    down.push({ r: n, depth });
    if (depth < 2) walkDown(n, depth + 1);
  };
  walkDown(cur, 1);
  if (down.length) { console.log('后来的版本：'); for (const { r, depth } of down) console.log(`  ${'  '.repeat(depth - 1)}${line(r)}`); }
  process.exit(0);
}

if (cmd === 'feedback') {
  const id = argv[1];
  const bad = argv.includes('--bad');
  const good = argv.includes('--good');
  const note = flag('--note', '');
  if (!id || (!bad && !good)) { console.log('用法：feedback <id> --bad|--good [--note "他说了什么"]'); process.exit(1); }
  try {
    const rows = fs.readFileSync(LEAVES_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const r = rows.find((x) => String(x.id) === String(id));
    if (!r) { console.log(`没有 id=${id} 这条`); process.exit(1); }
    r.trust = bad ? -1 : 1;
    if (!Array.isArray(r.feedback)) r.feedback = [];
    r.feedback.push({ ts: new Date().toISOString(), value: r.trust, note: String(note || '') });
    fs.writeFileSync(LEAVES_FILE, rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    refreshTree();
    console.log(`${id} 标记为${bad ? '「不对 / 不可信」' : '「有用 / 确认过」'}${note ? `（${note}）` : ''} ｜ 当前 trust=${r.trust}`);
  } catch (e) {
    console.log(`feedback 失败：${e?.message ?? e}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'stats') {
  const tally = (f) => leaves.reduce((a, r) => { const k = r[f] ?? '-'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const boxTally = leaves.reduce((a, r) => { const k = Math.max(0, Math.min(4, Number(r.box) || 0)); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const lab = ['新卡', '浅', '中', '深', '沉底'];
  const boxStr = Object.keys(boxTally).sort().map((k) => `${lab[k]}${boxTally[k]}`).join(' ');
  console.log(`叶 ${leaves.length} 条 ｜ visibility ${JSON.stringify(tally('visibility'))} ｜ state ${JSON.stringify(tally('state'))}`);
  console.log(`盒子 ${boxStr} ｜ 已归档(超深层) ${leaves.filter((r) => r.archived).length} 条`);
  console.log(`枝 ${groupBranches(leaves).length} 条 ｜ 过期(valid_to) ${leaves.filter((r) => r.valid_to).length} ｜ 被取代 ${leaves.filter((r) => r.superseded_by).length}`);
  console.log(`干 ${readOr(TRUNK).length} 字 ｜ 卡里那一节 ${readOr(PUBLIC_MEM).length} 字`);
  process.exit(0);
}

console.log(`不认识的命令「${cmd}」，敲 help 看用法`);
process.exit(1);
