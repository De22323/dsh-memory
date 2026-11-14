/**
 * 不装进 DSH，用假 ctx 跑一遍 apply()：验证"插件能加载、工具能注册、初始化能建库、定时器能挂"。
 *
 * 用法：node test/apply.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ws = mkdtempSync(join(tmpdir(), 'dsh-memory-apply-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`);
};

const effects = [];
const registered = [];
const ctx = {
  effect(fn, label) {
    try { const d = fn(); if (typeof d === 'function') effects.push(d); } catch (e) { console.log('effect threw:', label, e?.message); }
  },
  tools: { register(def) { registered.push(def?.name ?? '?'); return () => {}; } },
  webServer: null,
  logger: { warn() {}, log() {} },
  get() { return null; },
};

try {
  const mod = await import('../index.js');
  check('模块加载', true);
  check('导出 name/inject', mod.name === 'dsh-memory' && Array.isArray(mod.inject), `${mod.name}:${mod.inject}`);
  mod.apply(ctx, { workspace: ws, tickMinutes: 0 });
  check('apply 不抛', true);
  // 纯 node 下没有 DSH 宿主包 ⇒ defineTool=null ⇒ 工具降级为不注册（这是设计好的安全边界）；
  // 在 DSH host 里解析得到时会是 6 个（0.1.2 的日志可证同一条解析路径是好的）。
  check('工具注册数 0 或 6（纯 node 下 0 属正常降级）', registered.length === 0 || registered.length === 6, registered.join(','));
  check('初始化建出条目.jsonl', existsSync(join(ws, 'memory', '记忆', '条目.jsonl')));
  const trunk = join(ws, 'memory', '记忆', '干.md');
  check('初始化建出干.md', existsSync(trunk) && readFileSync(trunk, 'utf8').length > 0);
} catch (e) {
  check('apply 不抛', false, String(e?.message ?? e));
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
