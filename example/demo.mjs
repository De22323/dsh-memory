/**
 * 不用装 DSH，直接跑一遍记忆库的最小演示。
 *
 *   node example/demo.mjs
 *
 * 做的事：在系统临时目录建一个空记忆库 → 写一条 → 搜出来 → 取正文 → 看体检。
 * 跑完自动删临时目录，不碰你自己的记忆。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const ws = mkdtempSync(join(tmpdir(), 'dsh-memory-demo-'));

mkdirSync(join(ws, 'memory', '记忆'), { recursive: true });
writeFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), '');
writeFileSync(join(ws, 'memory', '记忆', '干.md'), '# 干\n');

const env = { ...process.env, MEM_HOME: ws };
let seq = 0;
function run(file, args) {
  const outFile = join(ws, `.out-${seq++}.txt`);
  const fd = openSync(outFile, 'w');
  try {
    // sandbox 下不能用管道 → stdout/stderr 走临时文件
    spawnSync(process.execPath, [join(SCRIPTS, file), ...args], {
      cwd: ws, env, stdio: ['ignore', fd, fd], timeout: 60000,
    });
  } finally { closeSync(fd); }
  return readFileSync(outFile, 'utf8').trim();
}

console.log('== 1. 写一条 ==');
console.log(run('memory-add.mjs', ['第一次用这套记忆：它把我说的话写进一个纯文本文件', '--kind', 'fact', '--imp', '3', '--parent', 'b-第一次']));

console.log('\n== 2. 搜一下（只回标题 + id）==');
console.log(run('memory-get.mjs', ['search', '第一次用']));

const row = JSON.parse(readFileSync(join(ws, 'memory', '记忆', '条目.jsonl'), 'utf8').trim().split('\n')[0]);
console.log('\n== 3. 取正文 ==');
console.log(run('memory-get.mjs', ['get', row.id]));

console.log('\n== 4. 体检 ==');
console.log(run('memory-get.mjs', ['stats']));

console.log('\n== 5. 生成物（这些是人可以读的投影）==');
console.log(readdirSync(join(ws, 'memory')).join('  '));

rmSync(ws, { recursive: true, force: true });
console.log('\n演示结束，临时库已删。');
