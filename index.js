/**
 * dsh-memory · 记忆框架插件（本地 · v0.2.0）
 *
 * 干什么：把 `memory\` 那套记忆框架整个装进一个插件，不靠"我记得去敲 node tools\memory-*.mjs"。
 *
 *   · 六个工具：memory_add / memory_search / memory_tree / memory_get / memory_feedback / memory_stats
 *   · 一个定时器：每 tickMinutes 分钟跑一次 `memory-sink --auto` + `memory-decay --apply` + `memory-boxes`
 *     （三个脚本自己会判断"要不要动"，没到线就是安全空操作）
 *   · 自带脚本：插件目录里带了 scripts\（优先用工作区 tools\ 的最新版；没有就用自带的）
 *   · 首次挂载：工作区没有 memory\ 就按 template\ 建一个空库
 *
 * 设计边界（照 dsh-schedule 的口径）：
 *   · **只有 host 半边**（没有 client.js）—— 不做客户端，就没有"import 失败把整个页面搞崩"的风险面
 *   · 唯一真相仍是 `memory\记忆\条目.jsonl`，写盘全部走原来的脚本（插件只是调度器，不重写逻辑）
 *   · 不手改 profile bundles 之外的东西；装/挂走 link + 插件页同款流程
 *
 * 工具注册依赖 `@deepseek-ai/dsh-tools` 的 defineTool：
 *   解析不到就**降级为不注册工具**（插件本身照常挂载，不炸插件树）。
 *   解析顺序照 dsh-undo-savepoint：ESM 裸 import → createRequire → DSH_ROOT 兜底。
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

const DEFAULT_WORKSPACE = process.env.DSH_WORKSPACE || process.cwd();

/** 自己的日志：DSH 不给我们看插件加载日志，就自己落一份（排障用）。 */
let LOG_FILE = join(DEFAULT_WORKSPACE, 'runtime', 'dsh-memory.log');
const log = (m) => { try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`); } catch { /* 无写权限就算了 */ } };
log('module loaded; url=' + (import.meta.url || ''));

// ── defineTool：宿主包在 asar 里，junction 插件从工作区解析不到 ⇒ 多锚点试 ──
let defineTool = null;
let lastErr = '';
const anchors = [];
try { if (import.meta.url) anchors.push(import.meta.url); } catch { /* ignore */ }
if (process.env.USERPROFILE) anchors.push(join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json'));
if (process.env.DSH_ROOT) anchors.push(join(process.env.DSH_ROOT, 'package.json'));
try {
  const exeDir = dirname(process.execPath);
  anchors.push(join(exeDir, 'resources', 'app.asar', 'dsh', 'package.json'));
  anchors.push(join(exeDir, 'resources', 'app.asar', 'package.json'));
} catch { /* ignore */ }

for (const a of anchors) {
  try {
    const req = createRequire(a);
    const mod = req('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) { defineTool = mod.defineTool; lastErr = 'resolved via ' + a; break; }
  } catch (e) { lastErr = String(e?.message ?? e); }
}
if (!defineTool) {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) { defineTool = mod.defineTool; lastErr = 'resolved via bare import'; }
  } catch (e) { lastErr = String(e?.message ?? e); }
}
log(`defineTool=${defineTool ? 'ok' : 'missing'}; note=${lastErr}; DSH_ROOT=${process.env.DSH_ROOT || '(unset)'}; electron=${process.versions.electron || 'no'}`);

export const name = 'dsh-memory';
export const inject = ['webServer', 'tools'];

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

/** 在 DSH host 里跑 node 脚本：Electron 下用系统 node，避免把 exe 当 node。 */
function nodeExe() {
  if (!process.versions.electron) return process.execPath;
  const sys = 'C:\\Program Files\\nodejs\\node.exe';
  return existsSync(sys) ? sys : process.execPath;
}

function runNode(script, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      nodeExe(),
      [script, ...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          MEM_HOME: opts.memHome || undefined,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout ?? '').trim(),
          err: String(stderr ?? '').trim() || (err ? String(err.message ?? err) : ''),
        });
      },
    );
  });
}

export function apply(ctx, config = {}) {
  const workspace = String(config?.workspace || DEFAULT_WORKSPACE);
  LOG_FILE = join(workspace, 'runtime', 'dsh-memory.log');
  log('apply called; config=' + JSON.stringify(config ?? {}));
  const toolsDir = join(workspace, 'tools');
  const localScripts = join(PLUGIN_DIR, 'scripts');
  const tickMinutes = Number(config?.tickMinutes ?? 30);
  const logger = ctx?.logger ?? console;
  const warn = (m) => { try { logger.warn(`[dsh-memory] ${m}`); } catch { /* 静默 */ } };

  /** 有工作区 tools\ 的最新脚本就用它；没有就用插件自带的。 */
  const scriptPath = (file) => {
    const ws = join(toolsDir, file);
    return existsSync(ws) ? ws : join(localScripts, file);
  };

  /** 副本一致性：插件自带 scripts 与工作区 tools 同名文件比哈希。不一致只写日志，绝不自动改。 */
  const checkScripts = () => {
    const files = [
      'memory-index.mjs', 'memory-tree.mjs', 'memory-get.mjs', 'memory-add.mjs',
      'memory-feedback.mjs', 'memory-sink.mjs', 'memory-decay.mjs', 'memory-boxes.mjs',
      'memory-archive.mjs', 'memory-links.mjs',
    ];
    const diff = [];
    for (const f of files) {
      const a = join(toolsDir, f);
      const b = join(localScripts, f);
      if (!existsSync(a) || !existsSync(b)) continue;
      const ha = createHash('sha256').update(readFileSync(a)).digest('hex');
      const hb = createHash('sha256').update(readFileSync(b)).digest('hex');
      if (ha !== hb) diff.push(f);
    }
    if (diff.length) log('⚠ scripts differ (tools vs bundled): ' + diff.join(', ') + ' —— 跑 node sync-scripts.mjs 同步副本');
    else log('scripts consistent with tools');
  };
  checkScripts();

  /** 首次挂载 / 每次挂载：按 template 补齐缺失的文件（已有的一律不覆盖，不动他的数据）。 */
  const ensureWorkspace = () => {
    const tpl = join(PLUGIN_DIR, 'template', 'memory');
    const dst = join(workspace, 'memory');
    if (!existsSync(tpl)) return 0;
    let created = 0;
    const copyTree = (src, into) => {
      for (const ent of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, ent.name);
        const d = join(into, ent.name);
        if (ent.isDirectory()) { mkdirSync(d, { recursive: true }); copyTree(s, d); }
        else if (!existsSync(d)) { copyFileSync(s, d); created++; }
      }
    };
    try {
      mkdirSync(dst, { recursive: true });
      copyTree(tpl, dst);
      if (created) log(`workspace: ${created} file(s) created from template (${workspace})`);
      return created;
    } catch (e) {
      warn(`init failed: ${String(e?.message ?? e)}`);
      log('init failed: ' + String(e?.message ?? e));
      return 0;
    }
  };
  const inited = ensureWorkspace();

  const register = (def) => {
    if (!defineTool) { warn(`defineTool unavailable; tool ${def.name} skipped`); log(`tool skipped (no defineTool): ${def.name}`); return; }
    try {
      ctx.effect(() => {
        const dispose = ctx.tools.register(defineTool(def));
        log(`tool registered: ${def.name}`);
        return () => { try { dispose?.(); } catch { /* ignore */ } };
      }, `dsh-memory.tool.${def.name}`);
    } catch (e) {
      warn(`tool ${def.name} failed: ${String(e?.message ?? e)}`);
      log(`tool FAILED: ${def.name} -> ${String(e?.message ?? e)}`);
    }
  };

  const run = (file, argv, timeout = 60000) =>
    runNode(scriptPath(file), argv, { cwd: workspace, memHome: workspace, timeout });

  register({
    name: 'memory_add',
    description: '写一条记忆进 memory\\记忆\\条目.jsonl（唯一真相）。每轮收尾挑 0~3 条用这个写：会自动做取代判定（同枝 + 高度相似才标 superseded）、重建干.md、把改动落成可回滚的收据。待办别写这儿。',
    parameters: {
      content: { type: 'string', description: '要记的一句话（一行）。' },
      kind: { type: 'string', description: 'fact / event / tool / person / meme / mood / date，默认 fact。' },
      imp: { type: 'number', description: '重要度 1-5，默认 3。' },
      parent: { type: 'string', description: '挂到哪个枝（如 b-记忆机制）。不填会自动猜，容易裂枝。' },
      supersedes: { type: 'string', description: '可选：明确的旧条 id，标它被这条取代。' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const content = String(args?.content ?? '').trim();
      if (!content) return '缺少 content（要记的那句话）。';
      const argv = [content];
      if (args?.kind) argv.push('--kind', String(args.kind));
      if (args?.imp) argv.push('--imp', String(Number(args.imp) || 3));
      if (args?.parent) argv.push('--parent', String(args.parent));
      if (args?.supersedes) argv.push('--supersedes', String(args.supersedes));
      const r = await run('memory-add.mjs', argv);
      return r.ok ? (r.out || '已写入。') : `memory_add 失败：${r.err}`;
    },
  });

  register({
    name: 'memory_search',
    description: '搜记忆（只回「枝 › 标题」+ id，不吐正文）。想要正文用 memory_get。',
    parameters: { query: { type: 'string', description: '关键词。' } },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const q = String(args?.query ?? '').trim();
      if (!q) return '缺少 query。';
      const r = await run('memory-get.mjs', ['search', q]);
      return r.ok ? (r.out || '(没有命中)') : `memory_search 失败：${r.err}`;
    },
  });

  register({
    name: 'memory_tree',
    description: '看记忆的目录（枝 → 每条标题，不带正文）。不填 branch 给完整目录，填了展开那一枝。要正文再 memory_get。',
    parameters: { branch: { type: 'string', description: '可选：枝名（如 b-转专业）。' } },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const argv = ['tree'];
      const b = String(args?.branch ?? '').trim();
      if (b) argv.push(b);
      const r = await run('memory-get.mjs', argv);
      return r.ok ? (r.out || '(空)') : `memory_tree 失败：${r.err}`;
    },
  });

  register({
    name: 'memory_get',
    description: '取一条记忆的正文（顺手回写 access，让衰减知道它还活着）。',
    parameters: { id: { type: 'string', description: '记忆 id，如 h-20261017-006。' } },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const id = String(args?.id ?? '').trim();
      if (!id) return '缺少 id。';
      const r = await run('memory-get.mjs', ['get', id]);
      return r.ok ? (r.out || '(空)') : `memory_get 失败：${r.err}`;
    },
  });

  register({
    name: 'memory_feedback',
    description: '给一条记忆打反馈：他说过不对/过时 → --bad（检索降权、枝页标 ⚠）；他说过有用/对 → --good（标 ✓）。',
    parameters: {
      id: { type: 'string', description: '记忆 id。' },
      verdict: { type: 'string', description: 'bad 或 good。' },
      note: { type: 'string', description: '可选：他原话或一句说明。' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const id = String(args?.id ?? '').trim();
      const verdict = String(args?.verdict ?? '').trim().toLowerCase();
      if (!id) return '缺少 id。';
      if (verdict !== 'bad' && verdict !== 'good') return 'verdict 只能是 bad 或 good。';
      const argv = ['feedback', id, verdict === 'bad' ? '--bad' : '--good'];
      if (args?.note) argv.push('--note', String(args.note));
      const r = await run('memory-get.mjs', argv);
      return r.ok ? (r.out || '已记。') : `memory_feedback 失败：${r.err}`;
    },
  });

  register({
    name: 'memory_stats',
    description: '记忆体检：叶/枝/干字数/过期/被取代/各档位分布。',
    parameters: {},
    output: TEXT_OUTPUT,
    execute: async () => {
      const r = await run('memory-get.mjs', ['stats']);
      return r.ok ? r.out : `memory_stats 失败：${r.err}`;
    },
  });

  // ── REST：给客户端侧栏 tab 供数据（webServer 是可选的，拿不到就跳过）──
  const readLeavesLocal = () => {
    try {
      const text = readFileSync(join(workspace, 'memory', '记忆', '条目.jsonl'), 'utf8');
      return text.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  };
  const buildMap = () => {
    const rows = readLeavesLocal().filter((r) => r && !r.superseded_by && !r.valid_to);
    const byBranch = new Map();
    for (const r of rows) {
      const b = r.parent || 'b-未归类';
      if (!byBranch.has(b)) byBranch.set(b, []);
      byBranch.get(b).push(r);
    }
    const branches = [...byBranch.entries()].map(([name, items]) => {
      const sorted = [...items].sort((a, b) => String(b.ts ?? b.created_at ?? '').localeCompare(String(a.ts ?? a.created_at ?? '')));
      return {
        name,
        count: sorted.length,
        latest: String(sorted[0]?.ts ?? sorted[0]?.created_at ?? '').slice(0, 10),
        items: sorted.map((r) => ({
          id: r.id,
          content: r.content,
          date: String(r.ts ?? r.created_at ?? '').slice(0, 10),
          kind: r.kind ?? '',
          imp: Number(r.imp) || 0,
        })),
      };
    }).sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
    return { ok: true, total: rows.length, generatedAt: new Date().toISOString(), branches };
  };
  try {
    const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : null);
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-memory/map',
        handler: (req, res) => {
          try {
            const body = JSON.stringify(buildMap());
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body);
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
          }
        },
      }), 'dsh-memory.route');
      log('webServer route registered: /api/dsh-memory/map');
    } else {
      log('webServer unavailable; map route skipped');
    }
  } catch (e) {
    log('webServer failed: ' + String(e?.message ?? e));
  }

  // ── 定时维护（sink / decay / boxes）──
  // ⚠ 护栏：这三件**都不该动条目.jsonl**（sink 只搬状态.md 的历史节、decay 只改 state 字段、
  //   boxes 只推盒子）。tick 前后各算一次 sha256，变了就判"有人在动唯一真相"：
  //   立刻停掉定时维护 + 写红字进 tick 日志。宁可不动，不能让它在后台犯糊涂。
  const TICK_LOG = join(workspace, 'runtime', 'dsh-memory-tick.log');
  const tickLog = (m) => {
    try {
      mkdirSync(join(workspace, 'runtime'), { recursive: true });
      appendFileSync(TICK_LOG, `[${new Date().toISOString()}] ${m}\n`);
    } catch { /* ignore */ }
  };
  const leafPath = join(workspace, 'memory', '记忆', '条目.jsonl');
  const leafFingerprint = () => {
    try { return createHash('sha256').update(readFileSync(leafPath)).digest('hex').slice(0, 12) + ':' + readFileSync(leafPath, 'utf8').split('\n').filter(Boolean).length; }
    catch { return 'missing'; }
  };

  if (Number.isFinite(tickMinutes) && tickMinutes > 0) {
    try {
      ctx.effect(() => {
        let stopped = false;
        const timer = setInterval(async () => {
          if (stopped) return;
          const before = leafFingerprint();
          try {
            const sink = await run('memory-sink.mjs', ['--auto'], 120000);
            const decay = await run('memory-decay.mjs', ['--apply'], 120000);
            const boxes = await run('memory-boxes.mjs', [], 60000);
            if (!sink.ok) warn(`sink failed: ${sink.err}`);
            if (!decay.ok) warn(`decay failed: ${decay.err}`);
            if (!boxes.ok) warn(`boxes failed: ${boxes.err}`);
            const after = leafFingerprint();
            tickLog([
              `sink=${sink.ok ? 'ok' : 'ERR'}`,
              `decay=${decay.ok ? 'ok' : 'ERR'}`,
              `boxes=${boxes.ok ? 'ok' : 'ERR'}`,
              `entries=${after === before ? 'unchanged' : 'CHANGED'}`,
            ].join(' '));
            if (before !== after) {
              stopped = true;
              tickLog(`!!! 条目.jsonl 在 tick 期间变了（${before} -> ${after}）——已停止定时维护，人工检查`);
              warn('memory tick STOPPED: 条目.jsonl changed during tick');
            }
          } catch (e) {
            tickLog('tick error: ' + String(e?.message ?? e));
            warn(`tick error: ${String(e?.message ?? e)}`);
          }
        }, tickMinutes * 60 * 1000);
        if (typeof timer?.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, 'dsh-memory.tick');
    } catch (e) {
      warn(`timer not registered: ${String(e?.message ?? e)}`);
    }
  }

  log(`apply done (workspace=${workspace}, tick=${tickMinutes}min, inited=${inited}, defineTool=${defineTool ? 'ok' : 'missing'})`);

  // ⚠ 启动自检：只写日志，不抛（抛了会把插件树炸掉）。
  const leaf = join(workspace, 'memory', '记忆', '条目.jsonl');
  if (!existsSync(leaf)) warn(`memory store missing: ${leaf}（跑一次 memory_add 会按模板建空的）`);
}
