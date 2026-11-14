// memory-decay.mjs -- 沉降的第二半已经并进盒子了（2026-11-11 深夜合并）。
//
// 以前这里是**另一套算法**：ratio = 没被碰的天数 / S，管 state（L1 / warm / cold）；
// 盒子（0-4）又按写死的天数算一套 —— 两套各说各话，翻卡只喂了一半，检索只认盒子。
// 合并后：**盒子是唯一真相**，state 只是它的投影：
//   0 新卡 / 1 浅   → L1
//   2 中   / 3 深   → warm
//   4 沉底          → cold
//   pinned 是另一回事（不参与沉降），原样保留。
//
// 这个脚本留下来做两件事：
//   ① 迁移 / 修复：把 state 校正成盒子的投影（幂等，全对齐就什么都不做）
//   ② 体检：报"有几条对不上"——两套数据漂移一眼可见
//
// 用法：
//   node tools\memory-decay.mjs            # 只看（默认 dry）
//   node tools\memory-decay.mjs --apply    # 真写（改前自动备份 + 收据）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLeaves, LEAVES } from './memory-index.mjs';
import { stateOfBox } from './lib/memory-card.mjs';
import { writeManifest } from './lib/memory-manifest.mjs';

/** 纯函数：算"哪些叶的 state 和盒子对不上"。不改任何东西。 */
export function planStateSync(leaves) {
  const out = [];
  for (const r of leaves) {
    if (!r || r.state === 'pinned') continue;
    if (r.superseded_by || r.valid_to) continue;          // 死掉的叶不动
    const want = stateOfBox(r.box);
    const cur = r.state ?? 'L1';
    if (want !== cur) out.push({ id: r.id, from: cur, to: want, box: Math.max(0, Math.min(4, Number(r.box) || 0)), content: String(r.content ?? '').slice(0, 42) });
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const HOME = path.resolve(import.meta.dirname, '..');
  const apply = process.argv.includes('--apply');
  const rows = readLeaves();
  const plan = planStateSync(rows);

  if (!plan.length) {
    console.log(`对得上：${rows.length} 条叶的 state 全等于「盒子的投影」，不动。`);
  } else {
    console.log(`对不上：${plan.length} 条（盒子是真相，state 跟着盒子走）`);
    for (const p of plan) console.log(`  ${p.id}  ${p.from} → ${p.to}（b${p.box}）  ｜${p.content}`);
    if (!apply) {
      console.log('\n（默认只看不动。真要写加 --apply；写前会自动备份。）');
    } else {
      const arch = path.join(HOME, 'memory', '归档-旧版本与记录');
      fs.mkdirSync(arch, { recursive: true });
      const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
      const before = fs.readFileSync(LEAVES, 'utf8');
      fs.copyFileSync(LEAVES, path.join(arch, `条目.jsonl.bak-${stamp}`));
      const byId = new Map(plan.map((p) => [p.id, p.to]));
      const next = rows.map((r) => (byId.has(r.id) ? { ...r, state: byId.get(r.id) } : r));
      const nextText = next.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const manifest = writeManifest({ actor: 'memory-decay', action: 'state-sync', files: [{ path: LEAVES, before, after: nextText }] });
      fs.writeFileSync(LEAVES, nextText, 'utf8');
      const after = readLeaves();
      const bad = after.filter((r, i) => JSON.stringify({ ...r, state: rows[i]?.state }) !== JSON.stringify(rows[i]));
      console.log(`\n已写入（收据 ${path.basename(manifest)} ｜ 备份 ${path.basename(arch)}\\条目.jsonl.bak-${stamp}）｜复核：${bad.length === 0 ? '只有 state 变了，其余字段逐字一致' : `⚠️ ${bad.length} 条有别的字段被动过`}`);
    }
  }
}
