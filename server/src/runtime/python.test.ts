import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { CallResult } from '../connectors/types.js';

// Shorter budget than prod: the runaway-script test has to actually wait it out.
process.env.PYTHON_TOOL_TIMEOUT_MS = '5000';
const { runPython, shutdownPython } = await import('./python.js');

const noInvoke = async (): Promise<CallResult> => ({ content: [{ type: 'text', text: 'unused' }] });

afterAll(() => shutdownPython());

describe('python tool runtime', () => {
  it('returns the value assigned to output', async () => {
    const { result } = await runPython(`output = {"sum": args["a"] + args["b"]}`, { args: { a: 2, b: 3 } }, noInvoke);
    expect(result.structuredContent).toEqual({ sum: 5 });
  });

  it('calls main(args) when defined, sync or async', async () => {
    const sync = await runPython(`def main(args):\n    return {"n": args["n"] * 2}`, { args: { n: 4 } }, noInvoke);
    expect(sync.result.structuredContent).toEqual({ n: 8 });

    const async_ = await runPython(
      `async def main(args):\n    return {"n": args["n"] + 1}`,
      { args: { n: 4 } },
      noInvoke,
    );
    expect(async_.result.structuredContent).toEqual({ n: 5 });
  });

  it('names the missing result instead of leaking a NameError', async () => {
    await expect(runPython(`x = 1`, { args: {} }, noInvoke)).rejects.toThrow(/never assigned 'output'/);
  });

  it('translates a top-level return into the actual rule', async () => {
    await expect(runPython(`if True:\n    return 1`, { args: {} }, noInvoke)).rejects.toThrow(
      /top-level 'return' is not allowed/,
    );
  });

  it('captures print() as stdout', async () => {
    const { stdout } = await runPython(`print("hello")\noutput = 1`, { args: {} }, noInvoke);
    expect(stdout).toContain('hello');
  });

  it('bridges call() and exposes text/structured/is_error', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const invoke = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
      seen.push({ name, args });
      return { content: [{ type: 'text', text: '{"rows": [1, 2]}' }] };
    };
    const { result } = await runPython(
      `r = await call("src.list", {"q": args["q"]})\noutput = {"n": len(r["structured"]["rows"]), "err": r["is_error"]}`,
      { args: { q: 'x' } },
      invoke,
    );
    expect(seen).toEqual([{ name: 'src.list', args: { q: 'x' } }]);
    expect(result.structuredContent).toEqual({ n: 2, err: false });
  });

  it('lets a script call a tool that is itself python (no self-deadlock)', async () => {
    // what the runtime really does: call() → invokeTool → another python body
    const invoke = async (_name: string, a: Record<string, unknown>, depth: number) => {
      const inner = await runPython(
        `output = {"doubled": args["n"] * 2}`,
        { args: a },
        async () => {
          throw new Error('too deep');
        },
        depth,
      );
      return inner.result;
    };
    const { result } = await runPython(
      `r = await call("py.inner", {"n": args["n"]})\noutput = {"outer": r["structured"]["doubled"] + 1}`,
      { args: { n: 20 } },
      invoke,
    );
    expect(result.structuredContent).toEqual({ outer: 41 });
  }, 30_000);

  it('surfaces steps from a composite run', async () => {
    const { result } = await runPython(`output = steps["a"]["text"].upper()`, {
      args: {},
      steps: { a: { text: 'done' } },
    });
    expect(result.content[0].text).toBe('DONE');
  });

  it('kills a runaway script and keeps serving afterwards', async () => {
    await expect(runPython(`while True:\n    pass`, { args: {} }, noInvoke)).rejects.toThrow(/timed out/);
    const { result } = await runPython(`output = "alive"`, { args: {} }, noInvoke);
    expect(result.content[0].text).toBe('alive');
  }, 30_000);
});

describe('python sandbox', () => {
  it('hides node internals from the js module', async () => {
    const { result } = await runPython(
      `import js\noutput = {k: hasattr(js, k) for k in ["process", "fetch", "require", "globalThis", "eval"]}`,
      { args: {} },
      noInvoke,
    );
    expect(result.structuredContent).toEqual({
      process: false,
      fetch: false,
      require: false,
      globalThis: false,
      eval: false,
    });
  });

  it('blocks pyodide.code.run_js', async () => {
    await expect(
      runPython(`from pyodide.code import run_js\noutput = run_js("1")`, { args: {} }, noInvoke),
    ).rejects.toThrow();
  });

  it('cannot open an outbound socket, even after clearing sys.meta_path', async () => {
    let connections = 0;
    const srv = net.createServer((s) => {
      connections++;
      s.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as net.AddressInfo;

    const code = [
      'import sys',
      'sys.meta_path.clear()',
      'import socket',
      'try:',
      '    s = socket.socket()',
      '    s.settimeout(2)',
      `    s.connect(("127.0.0.1", ${port}))`,
      '    output = "CONNECTED"',
      'except Exception as e:',
      '    output = "blocked: " + type(e).__name__',
    ].join('\n');

    const { result } = await runPython(code, { args: {} }, noInvoke);
    srv.close();
    expect(result.content[0].text).toMatch(/^blocked:/);
    expect(connections).toBe(0);
  }, 30_000);

  it('has no host filesystem', async () => {
    const { result } = await runPython(
      `try:\n    output = open("/etc/passwd").read()[:5]\nexcept Exception as e:\n    output = "blocked: " + type(e).__name__`,
      { args: {} },
      noInvoke,
    );
    expect(result.content[0].text).toMatch(/^blocked:/);
  });
});
