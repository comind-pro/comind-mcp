import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import type { CallResult } from '../connectors/types.js';

/**
 * Python tool runtime: user-authored code executed in Pyodide (CPython → WASM)
 * inside a worker thread.
 *
 * Sandbox, in layers:
 *  - `jsglobals: {}` — the Python `js` module sees only our `__call` bridge, so
 *    `process`, `require`, `fetch` and `pyodide.code.run_js` are unreachable.
 *  - Node module block — Pyodide's SOCKFS reaches the network by `require("ws")`
 *    (verified: an outbound connect DOES land on a real listener). Blocking the
 *    network modules in the worker's loader kills that before Pyodide loads.
 *    A Python-level guard would not do: user code can undo `sys.meta_path`.
 *  - No host FS: the Emscripten FS is in-memory, nothing is mounted from disk.
 *
 * So the only way out of a script is `call(...)` — an existing tool of the same
 * owner, which already carries its own auth, SSRF guard and call log.
 */

/** Invoke bridge: how a script's `call(...)` reaches the tool runtime. */
export type PyInvoke = (name: string, args: Record<string, unknown>, depth: number) => Promise<CallResult>;

export interface PythonContext {
  /** The tool's own arguments — `args` in the script. */
  args: Record<string, unknown>;
  /** Prior composite steps — `steps` in the script. Empty for a standalone tool. */
  steps?: Record<string, unknown>;
}

export interface PythonRunResult {
  result: CallResult;
  /** Everything the script printed, for the authoring UI. */
  stdout: string;
}

/** Worker source. Kept inline on purpose: no extra build step, no .ts/.js path
 *  juggling between `tsx` (dev) and `dist` (prod). */
const WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import Mod from 'node:module';

// Network kill-switch — must run before pyodide is imported.
const BLOCKED = new Set([
  'ws', 'net', 'tls', 'dgram', 'http', 'https', 'http2', 'child_process', 'cluster', 'inspector',
  'node:ws', 'node:net', 'node:tls', 'node:dgram', 'node:http', 'node:https', 'node:http2',
  'node:child_process', 'node:cluster', 'node:inspector',
]);
const origLoad = Mod._load;
Mod._load = function (request, ...rest) {
  if (BLOCKED.has(request)) throw new Error('network is disabled inside python tools');
  return origLoad.call(this, request, ...rest);
};

const BOOTSTRAP = [
  'import json as __json',
  'import js as __js',
  'async def call(name, args=None):',
  '    return __json.loads(await __js.__call(name, __json.dumps(args or {})))',
  'args = __json.loads(__args_json)',
  'steps = __json.loads(__steps_json)',
].join('\\n');

const MISSING_RESULT = "script finished but never assigned 'output'";

// Prefer main(args); fall back to output; never return a silent empty result.
const EPILOGUE = [
  'import inspect as __inspect',
  '__g = globals()',
  '__main = __g.get("main")',
  'if callable(__main):',
  '    __r = __main(args)',
  '    if __inspect.isawaitable(__r):',
  '        __r = await __r',
  'elif "output" in __g:',
  '    __r = __g["output"]',
  'else:',
  '    raise RuntimeError("script finished but never assigned \\'output\\' (and defined no \\'main\\')")',
  '__json.dumps(__r, default=str)',
].join('\\n');

let stdout = [];
let pyPromise = null;
let seq = 0;
const pending = new Map();

function bridgeCall(name, argsJson) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, name, argsJson });
  });
}

async function getPyodide() {
  if (!pyPromise) {
    pyPromise = import('pyodide').then((m) =>
      m.loadPyodide({
        // Resolved by the host: an eval-worker has no module path of its own, and
        // pyodide's own guess lands on a non-existent src/js/ dev path.
        indexURL: workerData.indexURL,
        jsglobals: { __call: bridgeCall },
        stdout: (s) => stdout.push(s),
        stderr: (s) => stdout.push(s),
      }),
    );
  }
  return pyPromise;
}

// Pyodide's own frames say nothing to the person writing the tool.
const NOISE = /_pyodide\\/_base\\.py|await CodeRunner|\\.run_async\\(|await coroutine|coroutine = eval\\(|\\.\\.\\.<\\d+ lines>\\.\\.\\./;

/** Turn a Python failure into something the tool author can act on: the
 *  top-level-return rule, the missing-result rule, or their own traceback
 *  without our plumbing in it. */
function friendly(err) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes("'return' outside function")) {
    return "top-level 'return' is not allowed — assign to 'output', or wrap the logic in 'def main(args)'";
  }
  const missing = msg.indexOf(MISSING_RESULT);
  if (missing >= 0) return msg.slice(missing, msg.indexOf('\\n', missing) + 1 || undefined).trim();
  const trimmed = msg
    .split('\\n')
    .filter((line) => !NOISE.test(line))
    .join('\\n')
    .trim();
  return trimmed || msg;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'callResult') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.json);
    return;
  }
  if (msg.type !== 'run') return;

  stdout = [];
  let ns = null;
  try {
    const py = await getPyodide();
    ns = py.toPy({});
    ns.set('__args_json', msg.argsJson);
    ns.set('__steps_json', msg.stepsJson);
    await py.runPythonAsync(BOOTSTRAP, { globals: ns });
    await py.runPythonAsync(msg.code, { globals: ns });
    const json = await py.runPythonAsync(EPILOGUE, { globals: ns });
    parentPort.postMessage({ type: 'done', json, stdout: stdout.join('') });
  } catch (err) {
    parentPort.postMessage({ type: 'done', error: friendly(err), stdout: stdout.join('') });
  } finally {
    pending.clear();
    if (ns) try { ns.destroy(); } catch { /* already gone */ }
  }
});
`;

/** Where pyodide's wasm/stdlib actually live — same answer under tsx and dist. */
const indexURL = `${path.dirname(createRequire(import.meta.url).resolve('pyodide/pyodide.mjs'))}/`;

/**
 * One worker (and one queue) PER NESTING LEVEL. Runs at the same level are
 * serialised — a Pyodide boot costs ~1s, so a worker per call would be worse.
 * But a script calling a tool that is itself a python tool must NOT wait behind
 * itself, so the nested run goes to the next level's worker. Same queue for both
 * = deadlock until timeout.
 *
 * ponytail: levels are lazy, so the common case is still exactly one worker.
 */
const MAX_PY_DEPTH = 3;
const workers: Array<Worker | null> = [];
const queues: Array<Promise<unknown>> = [];

function getWorker(level: number): Worker {
  let w = workers[level];
  if (!w) {
    w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { indexURL },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.unref(); // never hold the process open
    workers[level] = w;
  }
  return w;
}

/** Drop a level's worker (timeout / crash). The next run there boots a fresh one. */
function killWorker(level: number): void {
  const w = workers[level];
  workers[level] = null;
  void w?.terminate();
}

/** What a script sees as the return value of `call(...)`. */
function toScriptResult(res: CallResult): { text: string; structured: unknown; is_error: boolean } {
  const text = res.content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  let structured = res.structuredContent;
  if (structured === undefined) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = null;
    }
  }
  return { text, structured: structured ?? null, is_error: Boolean(res.isError) };
}

function toCallResult(json: string): CallResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { content: [{ type: 'text', text: json }] };
  }
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function runOnce(code: string, ctx: PythonContext, invoke: PyInvoke, depth: number, level: number) {
  const w = getWorker(level);
  let calls = 0;

  return new Promise<PythonRunResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        killWorker(level); // the only thing that stops `while True: pass`
        reject(new Error(`python tool timed out after ${config.pythonTimeoutMs}ms`));
      });
    }, config.pythonTimeoutMs);

    const onMessage = async (msg: Record<string, string>) => {
      if (msg.type === 'call') {
        if (++calls > config.pythonMaxCalls) {
          w.postMessage({ type: 'callResult', id: msg.id, error: `call() limit exceeded (${config.pythonMaxCalls})` });
          return;
        }
        try {
          const res = await invoke(msg.name, JSON.parse(msg.argsJson) as Record<string, unknown>, depth + 1);
          if (!settled) w.postMessage({ type: 'callResult', id: msg.id, json: JSON.stringify(toScriptResult(res)) });
        } catch (err) {
          if (!settled) {
            w.postMessage({ type: 'callResult', id: msg.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }
      if (msg.type === 'done') {
        finish(() => {
          if (msg.error) reject(new Error(msg.error));
          else resolve({ result: toCallResult(msg.json), stdout: msg.stdout ?? '' });
        });
      }
    };

    const die = (err: Error) =>
      finish(() => {
        killWorker(level);
        reject(err);
      });
    const onError = (err: Error) => die(err);
    const onExit = () => die(new Error('python worker exited unexpectedly'));

    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.postMessage({
      type: 'run',
      code,
      argsJson: JSON.stringify(ctx.args ?? {}),
      stepsJson: JSON.stringify(ctx.steps ?? {}),
    });
  });
}

/** Run a python tool body. Serialised against other runs at the same nesting level. */
export function runPython(code: string, ctx: PythonContext, invoke: PyInvoke, depth = 0): Promise<PythonRunResult> {
  const level = Math.min(depth, MAX_PY_DEPTH);
  if (level >= MAX_PY_DEPTH) {
    return Promise.reject(new Error(`python tools nested more than ${MAX_PY_DEPTH} levels deep`));
  }
  const run = () => runOnce(code, ctx, invoke, depth, level);
  const next = (queues[level] ?? Promise.resolve()).then(run, run);
  queues[level] = next.catch(() => {}); // a failed run must not poison the queue
  return next;
}

/** Test-only: release the workers so vitest can exit. */
export function shutdownPython(): void {
  for (let i = 0; i < workers.length; i++) killWorker(i);
}
