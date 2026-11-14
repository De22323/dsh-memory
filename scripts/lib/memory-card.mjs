// lib/memory-card.mjs -- 卡片的两个纯函数：起标题、算初始盒子。
// 单独一份，是因为 memory-index.mjs 和 memory-tree.mjs 互相不能 import（会成环）。

/** 正文 -> 标题（≤20 字）。v3 之后新条目应该直接带 title，这个只当兜底。 */
export function makeTitle(content) {
  const s0 = String(content ?? '');
  let s = s0
    .replace(/\d{4}-\d{2}-\d{2}[ T]?[\d:]*/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(早上|上午|中午|下午|傍晚|晚上|深夜|夜里|凌晨|今天|昨天|刚才|晚|早)[\s,，:]?/, '')
    .trim();
  const seg = s.split(/[：:。；;（(]/)[0].trim();
  let t = seg.length >= 4 ? seg : s;
  t = t.replace(/^[：:，,。；;、～~—\-·\s]+/, '').replace(/\s+/g, ' ').trim();
  if (!t) t = s0.slice(0, 20);
  if (t.length > 20) t = t.slice(0, 19) + '…';
  return t;
}

const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

/** 盒子的三档宽度 = 稳定度 S 的倍数（2026-11-11 晚改）。0 新卡 / 1 浅 / 2 中 / 3 深 / 4 沉底。 */
export const BOX_SPAN = { shallow: 1, middle: 3, deep: 9 };
/** 深层门槛：想从「深 / 沉底」回浅，最近 30 天内要翻过 OPEN 次。 */
export const DEEP_GATE_OPENS = 3;
export const DEEP_GATE_DAYS = 30;

/**
 * 盒子位置（**由 S 驱动**，2026-11-11 晚改）：
 *   · 距上次被碰 ≤ S        → 1 浅
 *   · ≤ 3S                  → 2 中
 *   · ≤ 9S                  → 3 深
 *   · 更久                  → 4 沉底
 *   · 建了不到 7 天         → 0 新卡
 *
 * 为什么换成 S：S 是"这条能扛多久不被碰"（kind × imp，且每翻一次会变大），
 * 用固定的 30/90/180 天，等于假装所有记忆一样稳 —— 翻十次的和没翻过的一样往下沉。
 */
export function boxOf(e, now = Date.now()) {
  const born = Date.parse(e?.ts || e?.created_at) || 0;
  const acc = (Array.isArray(e?.access) ? e.access : []).map(toMs).filter(Number.isFinite);
  const last = Math.max(born, ...acc, 0);
  const daysBorn = (now - born) / 86400_000;
  const daysTouch = (now - last) / 86400_000;
  const S = Number(e?.S) > 0 ? Number(e.S) : 7;
  if (daysBorn <= 7) return 0;
  if (daysTouch <= S * BOX_SPAN.shallow) return 1;
  if (daysTouch <= S * BOX_SPAN.middle) return 2;
  if (daysTouch <= S * BOX_SPAN.deep) return 3;
  return 4;
}

/** 每天结算：时间说它该更深就往下推（可能一次多档）；往浅只能靠翻卡。 */
export function planBoxRise(e, now = Date.now()) {
  const want = boxOf(e, now);
  const cur = Math.max(0, Math.min(4, Number(e?.box) || 0));
  return want > cur ? want : cur;
}

/** 最近 windowDays 天里被翻过几次（access 的第一条是"落下来那一刻"，不算翻卡）。 */
export function opensWithin(e, windowDays = DEEP_GATE_DAYS, now = Date.now()) {
  const acc = (Array.isArray(e?.access) ? e.access : []).map(toMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!acc.length) return 0;
  const [born] = acc;
  return acc.filter((t) => t !== born && now - t <= windowDays * 86400_000).length;
}

/** 盒子 → 档位（**合并后的唯一口径**，2026-11-11 深夜定：盒子是真相，state 是它的投影）。
 *  0/1 浅 → L1 ｜ 2/3 中深 → warm ｜ 4 沉底 → cold。pinned 是另一回事，另存。 */
export function stateOfBox(box) {
  const b = Math.max(0, Math.min(4, Number(box) || 0));
  return b <= 1 ? 'L1' : b <= 3 ? 'warm' : 'cold';
}

/**
 * 翻卡回浅（2026-11-11 晚加）：一次只回一档，**深层要反复翻才回得来**。
 *   · 0/1 层：不动（新卡/浅层本来就是最前面）
 *   · 2 层：翻一次 → 1
 *   · 3/4 层：最近 30 天翻够 DEEP_GATE_OPENS 次才允许回一档
 * 传进来的 e 应该已经带上"这一次"的 access（也就是 planTouch 拼好的 out）。
 */
export function planBoxOnTouch(e, now = Date.now()) {
  const cur = Math.max(0, Math.min(4, Number(e?.box) || 0));
  if (cur <= 1) return cur;
  if (cur >= 3 && opensWithin(e, DEEP_GATE_DAYS, now) < DEEP_GATE_OPENS) return cur;
  return cur - 1;
}
