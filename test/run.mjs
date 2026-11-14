/**
 * dsh-memory 插件自带脚本的冒烟测试。
 *
 * 用法：node test/run.mjs
 * 不碰真实记忆：在系统临时目录里建一个空 workspace，MEM_HOME 指过去跑。
 *
 * ⚠ sandbox 下 node 起的子进程不能用管道（EPERM）⇒ stdout/stderr 走临时文件当 stdio。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const ws = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'));

mkdirSync(join(ws, 'memory', '记忆'), { recursive: true });
writeFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), '');
writeFileSync(join(ws, 'memory', '记忆', '干.md'), '# 干\n');

const env = { ...process.env, MEM_HOME: ws };
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).replace(/\n/g, ' | ').slice(0, 160) : ''}`);
};

let seq = 0;
function run(file, args) {
  const outFile = join(ws, `.out-${seq++}.txt`);
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [join(SCRIPTS, file), ...args], {
      cwd: ws, env, stdio: ['ignore', fd, fd], timeout: 60000,
    });
  } finally {
    closeSync(fd);
  }
  if (r.error) throw r.error;
  return readFileSync(outFile, 'utf8');
}

try {
  // 1. 写一条
  const out = run('memory-add.mjs', ['测试记忆：插件自带脚本能写进去', '--kind', 'fact', '--imp', '3', '--parent', 'b-测试']);
  check('memory-add 执行', typeof out === 'string', out);

  const lines = readFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  check('条目.jsonl 有 1 条', lines.length === 1, `lines=${lines.length}`);
  let row = null;
  try { row = JSON.parse(lines[0] ?? '{}'); } catch { /* 下面 fail */ }
  check('条目能解析', !!row && row.id && String(row.content).includes('测试记忆'), row ? row.id : 'json parse failed');

  // 2. 搜
  const search = run('memory-get.mjs', ['search', '测试记忆']);
  check('memory-search 命中', search.includes('测试') && search.includes('b-测试'), search);

  // 3. 取正文
  const get = run('memory-get.mjs', ['get', row.id]);
  check('memory-get 能取到', get.includes('测试记忆'), get);

  // 4. 目录树
  const tree = run('memory-get.mjs', ['tree']);
  check('memory-tree 有这一枝', tree.includes('b-测试'), tree);

  // 5. 体检
  const stats = run('memory-get.mjs', ['stats']);
  check('memory-stats 出数字', /叶\s*\d+\s*条/.test(stats), stats);

  // 6. 投影生成物
  const trunk = readFileSync(join(ws, 'memory', '记忆', '干.md'), 'utf8');
  check('干.md 被重建', trunk.length > 0, `${trunk.length} 字`);
  const dirfile = join(ws, 'memory', '目录.md');
  check('目录.md 生成', readFileSync(dirfile, 'utf8').length > 0, '');
} finally {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
