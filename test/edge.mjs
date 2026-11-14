/**
 * 边界测试：空库、坏行、不存在的 id、重复写、模板不覆盖。
 *
 * 用法：node test/edge.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, openSync, closeSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const ws = mkdtempSync(join(tmpdir(), 'dsh-memory-edge-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).replace(/\n/g, ' | ').slice(0, 160) : ''}`);
};

const env = { ...process.env, MEM_HOME: ws };
let seq = 0;
function run(file, args) {
  const outFile = join(ws, `.out-${seq++}.txt`);
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [join(SCRIPTS, file), ...args], { cwd: ws, env, stdio: ['ignore', fd, fd], timeout: 60000 });
  } finally { closeSync(fd); }
  return { status: r.status, text: readFileSync(outFile, 'utf8') };
}

mkdirSync(join(ws, 'memory', '记忆'), { recursive: true });
writeFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), '');
writeFileSync(join(ws, 'memory', '记忆', '干.md'), '# 干\n');

try {
  // 1. 空库搜索：不崩
  const r1 = run('memory-get.mjs', ['search', '随便什么']);
  check('空库搜索不崩', r1.status === 0, `status=${r1.status} ${r1.text}`);

  // 2. 写一条
  run('memory-add.mjs', ['边界测试：第一条', '--kind', 'fact', '--imp', '2', '--parent', 'b-测试']);
  // 3. 塞一行坏 JSON，再搜索：不崩、仍能找到好那条
  appendFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), '{"坏掉的":\n');
  const r3 = run('memory-get.mjs', ['search', '边界测试']);
  check('坏 JSON 行下搜索不崩', r3.status === 0 && r3.text.includes('边界测试'), `status=${r3.status} ${r3.text}`);

  // 4. 取不存在的 id：不崩进程（允许非零退出，但不许栈溢出）
  const r4 = run('memory-get.mjs', ['get', 'h-19990101-999']);
  check('取不存在的 id 不崩', !/at .*\.mjs:\d+/.test(r4.text) || r4.status === 0, `status=${r4.status} ${r4.text}`);

  // 5. 重复写同样的话：不崩（可能标取代）
  const r5 = run('memory-add.mjs', ['边界测试：第一条', '--kind', 'fact', '--imp', '2', '--parent', 'b-测试']);
  check('重复写不崩', r5.status === 0, r5.text);

  // 6. 模板不覆盖：预置自定义身份.md，apply 后还在
  const idPath = join(ws, 'memory', '身份.md');
  const mine = '# 我的身份\n\n这句是我自己写的，不许被模板覆盖。\n';
  writeFileSync(idPath, mine);
  const ctx = {
    effect(fn) { try { fn(); } catch { /* ignore */ } },
    tools: { register() { return () => {}; } },
    webServer: null,
    logger: { warn() {}, log() {} },
    get() { return null; },
  };
  const mod = await import('../index.js');
  mod.apply(ctx, { workspace: ws, tickMinutes: 0 });
  check('模板不覆盖已有文件', readFileSync(idPath, 'utf8') === mine);
  check('模板补齐缺失文件', existsSync(join(ws, 'memory', '待办.md')) && existsSync(join(ws, 'memory', '近况.md')));
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
