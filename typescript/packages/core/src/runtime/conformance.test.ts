// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PyodideRuntime } from './python/pyodide.ts'
import { QuickJsRuntime } from './js/quickjs.ts'
import type { BridgeDispatchFn, RunArgs } from './types.ts'

// The runtime conformance suite: one capability table, executed against
// every runtime in that runtime's own idiom, with the outcome verified
// on the MOUNT through a shell command, never through the runtime that
// wrote it. The spelling axis is the point: which guest spellings a
// runtime intercepts is exactly what diverges (mirrors the python
// tests/runtime/test_conformance.py). Known-broken rows run as
// it.fails with the reason beside the table; the mark comes off as
// each one is fixed.

// ts monty bridges only the typed Path arms; builtin open (any mode)
// and Path.stat answer PermissionError on mount paths, so no append
// spelling exists at all. py monty serves all of them.
const MONTY_OPEN_UNSUPPORTED =
  'ts monty: builtin open and Path.stat answer PermissionError on mount paths'

// The pyodide shim patches only open/io.open, os.listdir, os.stat and
// os.scandir, so every mutation spelling mutates MEMFS and never
// reaches the mount: a pre-boot file succeeds silently (exit 0), a
// post-boot file fails with the MEMFS miss. Either way the mount never
// changes.

// A writable open never backfills, so appending to a file the MEMFS
// has not seen starts from empty and the close-flush overwrites the
// mount content the run never read.

// The workspace bridge has no APPEND op, so every append close
// re-flushes the whole file: n appends ship O(n^2) bytes.

interface Row {
  capability: string
  spelling: string
  line: string
  setup?: string[]
  exitCode?: number
  lineOut?: string
  checks?: [cmd: string, want: string][]
  broken?: string
}

const MONTY_ROWS: Row[] = [
  {
    capability: 'mkdir',
    spelling: 'Path.mkdir',
    line: `python3 -c "from pathlib import Path; Path('/data/made').mkdir()"`,
    checks: [['ls /data', 'made']],
  },
  {
    capability: 'unlink',
    spelling: 'Path.unlink',
    line: `python3 -c "from pathlib import Path; Path('/data/gone.txt').unlink()"`,
    setup: ['echo -n x > /data/gone.txt'],
    checks: [['ls /data', '!gone.txt']],
  },
  {
    capability: 'rmdir',
    spelling: 'Path.rmdir',
    line: `python3 -c "from pathlib import Path; Path('/data/hollow').rmdir()"`,
    setup: ['mkdir /data/hollow'],
    checks: [['ls /data', '!hollow']],
  },
  {
    capability: 'rename',
    spelling: 'Path.rename',
    line: `python3 -c "from pathlib import Path; Path('/data/a.txt').rename('/data/b.txt')"`,
    setup: ['echo -n one > /data/a.txt'],
    checks: [
      ['cat /data/b.txt', 'one'],
      ['ls /data', '!a.txt'],
    ],
  },
  {
    capability: 'rename-cross',
    spelling: 'Path.rename',
    line: `python3 -c "from pathlib import Path; Path('/data/c.txt').rename('/other/c.txt')"`,
    setup: ['echo -n keep > /data/c.txt'],
    exitCode: 1,
    checks: [
      ['cat /data/c.txt', 'keep'],
      ['ls /other', '!c.txt'],
    ],
  },
  {
    capability: 'read',
    spelling: 'open',
    line: `python3 -c "print(open('/data/r.txt').read())"`,
    setup: ['echo -n seen > /data/r.txt'],
    lineOut: 'seen',
    broken: MONTY_OPEN_UNSUPPORTED,
  },
  {
    capability: 'write',
    spelling: 'open',
    line: `python3 -c "f = open('/data/w1.txt', 'w'); f.write('data'); f.close()"`,
    checks: [['cat /data/w1.txt', 'data']],
    broken: MONTY_OPEN_UNSUPPORTED,
  },
  {
    capability: 'write',
    spelling: 'Path.write_text',
    line: `python3 -c "from pathlib import Path; Path('/data/w2.txt').write_text('data')"`,
    checks: [['cat /data/w2.txt', 'data']],
  },
  {
    capability: 'write-readonly',
    spelling: 'Path.write_text',
    line: `python3 -c "from pathlib import Path; Path('/ro/y.txt').write_text('nope')"`,
    exitCode: 1,
    checks: [['ls /ro', '!y.txt']],
  },
  {
    capability: 'stat',
    spelling: 'Path.stat',
    line: `python3 -c "from pathlib import Path; print(Path('/data/st.txt').stat().st_size)"`,
    setup: ['echo -n four > /data/st.txt'],
    lineOut: '4',
    broken: MONTY_OPEN_UNSUPPORTED,
  },
  {
    capability: 'append',
    spelling: 'open',
    line: `python3 -c "\nfor part in ['b', 'c', 'd']:\n    with open('/data/log.txt', 'a') as f:\n        f.write(part)\n"`,
    setup: ['echo -n a > /data/log.txt'],
    checks: [['cat /data/log.txt', 'abcd']],
    broken: MONTY_OPEN_UNSUPPORTED,
  },
  {
    capability: 'append-preserves',
    spelling: 'open',
    line: `python3 -c "f = open('/data/keep.txt', 'a'); f.write('Z'); f.close()"`,
    setup: ['echo -n a > /data/keep.txt'],
    checks: [['cat /data/keep.txt', 'aZ']],
    broken: MONTY_OPEN_UNSUPPORTED,
  },
]

const PYODIDE_ROWS: Row[] = [
  {
    capability: 'mkdir',
    spelling: 'os.mkdir',
    line: `python3 -c "import os; os.mkdir('/data/m1')"`,
    checks: [['ls /data', 'm1']],
  },
  {
    capability: 'mkdir',
    spelling: 'os.makedirs',
    line: `python3 -c "import os; os.makedirs('/data/m2/deep')"`,
    checks: [['ls /data/m2', 'deep']],
  },
  {
    capability: 'mkdir',
    spelling: 'Path.mkdir',
    line: `python3 -c "from pathlib import Path; Path('/data/m3').mkdir()"`,
    checks: [['ls /data', 'm3']],
  },
  {
    // A relative operand only names a mount through the guest cwd, so
    // the shim resolves against it before deciding what to record.
    capability: 'mkdir',
    spelling: 'os.mkdir relative to cwd',
    line: `python3 -c "import os; os.chdir('/data'); os.mkdir('m4')"`,
    checks: [['ls /data', 'm4']],
  },
  {
    capability: 'unlink',
    spelling: 'os.remove',
    line: `python3 -c "import os; os.remove('/data/f1.txt')"`,
    setup: ['echo -n x > /data/f1.txt'],
    checks: [['ls /data', '!f1.txt']],
  },
  {
    capability: 'unlink',
    spelling: 'Path.unlink',
    line: `python3 -c "from pathlib import Path; Path('/data/f2.txt').unlink()"`,
    setup: ['echo -n x > /data/f2.txt'],
    checks: [['ls /data', '!f2.txt']],
  },
  {
    capability: 'rmdir',
    spelling: 'os.rmdir',
    line: `python3 -c "import os; os.rmdir('/data/d1')"`,
    setup: ['mkdir /data/d1'],
    checks: [['ls /data', '!d1']],
  },
  {
    capability: 'rmdir',
    spelling: 'shutil.rmtree',
    line: `python3 -c "import shutil; shutil.rmtree('/data/d3')"`,
    setup: ['mkdir /data/d3', 'echo -n x > /data/d3/inner.txt'],
    checks: [['ls /data', '!d3']],
  },
  {
    capability: 'rename',
    spelling: 'os.rename',
    line: `python3 -c "import os; os.rename('/data/a1.txt', '/data/b1.txt')"`,
    setup: ['echo -n one > /data/a1.txt'],
    checks: [
      ['cat /data/b1.txt', 'one'],
      ['ls /data', '!a1.txt'],
    ],
  },
  {
    capability: 'rename',
    spelling: 'Path.rename',
    line: `python3 -c "from pathlib import Path; Path('/data/a3.txt').rename('/data/b3.txt')"`,
    setup: ['echo -n one > /data/a3.txt'],
    checks: [['cat /data/b3.txt', 'one']],
  },
  {
    // The shim's patched os.rename compares the mount of each side and
    // raises EXDEV, so this is a deliberate refusal rather than a
    // MEMFS miss: nonzero exit, source intact, nothing on the other mount.
    capability: 'rename-cross',
    spelling: 'os.rename',
    line: `python3 -c "import os; os.rename('/data/c.txt', '/other/c.txt')"`,
    setup: ['echo -n keep > /data/c.txt'],
    exitCode: 1,
    checks: [
      ['cat /data/c.txt', 'keep'],
      ['ls /other', '!c.txt'],
    ],
  },
  {
    capability: 'read',
    spelling: 'open',
    line: `python3 -c "print(open('/data/r.txt').read())"`,
    setup: ['echo -n seen > /data/r.txt'],
    lineOut: 'seen',
  },
  {
    capability: 'write',
    spelling: 'open',
    line: `python3 -c "f = open('/data/w1.txt', 'w'); f.write('data'); f.close()"`,
    checks: [['cat /data/w1.txt', 'data']],
  },
  {
    capability: 'write',
    spelling: 'Path.write_text',
    line: `python3 -c "from pathlib import Path; Path('/data/w2.txt').write_text('data')"`,
    checks: [['cat /data/w2.txt', 'data']],
  },
  {
    capability: 'write-readonly',
    spelling: 'open',
    line: `python3 -c "f = open('/ro/x.txt', 'w'); f.write('nope'); f.close()"`,
    exitCode: 1,
    checks: [['ls /ro', '!x.txt']],
  },
  {
    capability: 'stat',
    spelling: 'os.stat',
    line: `python3 -c "import os; print(os.stat('/data/st.txt').st_size)"`,
    setup: ['echo -n four > /data/st.txt'],
    lineOut: '4',
  },
  {
    capability: 'append',
    spelling: 'open',
    line: `python3 -c "\nfor part in ['b', 'c', 'd']:\n    with open('/data/log.txt', 'a') as f:\n        f.write(part)\n"`,
    setup: ['echo -n a > /data/log.txt'],
    checks: [['cat /data/log.txt', 'abcd']],
  },
  {
    capability: 'append-preserves',
    spelling: 'open',
    line: `python3 -c "f = open('/data/keep.txt', 'a'); f.write('Z'); f.close()"`,
    setup: ['echo -n a > /data/keep.txt'],
    checks: [['cat /data/keep.txt', 'aZ']],
  },
]

const QUICKJS_ROWS: Row[] = [
  {
    capability: 'mkdir',
    spelling: 'os.mkdir',
    line: `node -e "const rc = os.mkdir('/data/m1'); if (rc !== 0) throw new Error('rc ' + rc)"`,
    checks: [['ls /data', 'm1']],
  },
  {
    capability: 'unlink',
    spelling: 'os.remove',
    line: `node -e "const rc = os.remove('/data/f1.txt'); if (rc !== 0) throw new Error('rc ' + rc)"`,
    setup: ['echo -n x > /data/f1.txt'],
    checks: [['ls /data', '!f1.txt']],
  },
  {
    capability: 'rmdir',
    spelling: 'os.remove',
    line: `node -e "const rc = os.remove('/data/d1'); if (rc !== 0) throw new Error('rc ' + rc)"`,
    setup: ['mkdir /data/d1'],
    checks: [['ls /data', '!d1']],
  },
  {
    capability: 'rename',
    spelling: 'os.rename',
    line: `node -e "const rc = os.rename('/data/a1.txt', '/data/b1.txt'); if (rc !== 0) throw new Error('rc ' + rc)"`,
    setup: ['echo -n one > /data/a1.txt'],
    checks: [
      ['cat /data/b1.txt', 'one'],
      ['ls /data', '!a1.txt'],
    ],
  },
  {
    capability: 'rename-cross',
    spelling: 'os.rename',
    line: `node -e "console.log(os.rename('/data/c.txt', '/other/c.txt'))"`,
    setup: ['echo -n keep > /data/c.txt'],
    lineOut: '-44',
    checks: [
      ['cat /data/c.txt', 'keep'],
      ['ls /other', '!c.txt'],
    ],
  },
  {
    capability: 'read',
    spelling: 'std.open',
    line: `node -e "const f = std.open('/data/r.txt', 'r'); console.log(f.readAsString()); f.close()"`,
    setup: ['echo -n seen > /data/r.txt'],
    lineOut: 'seen',
  },
  {
    capability: 'write',
    spelling: 'std.open',
    line: `node -e "const w = std.open('/data/w1.txt', 'w'); w.puts('data'); w.close()"`,
    checks: [['cat /data/w1.txt', 'data']],
  },
  {
    // The refusal is std.open answering null; the errno field of the
    // error object is not filled by the synthesized std.open, so only
    // the null is pinned here.
    capability: 'write-readonly',
    spelling: 'std.open',
    line: `node -e "const e = {}; const w = std.open('/ro/x.txt', 'w', e); console.log(w === null)"`,
    lineOut: 'true',
    checks: [['ls /ro', '!x.txt']],
  },
  {
    capability: 'stat',
    spelling: 'os.stat',
    line: `node -e "const [st, e] = os.stat('/data/st.txt'); console.log(e, st.size)"`,
    setup: ['echo -n four > /data/st.txt'],
    lineOut: '0 4',
  },
  {
    capability: 'append',
    spelling: 'std.open',
    line: `node -e "for (const part of ['b', 'c', 'd']) { const w = std.open('/data/log.txt', 'a'); w.puts(part); w.close() }"`,
    setup: ['echo -n a > /data/log.txt'],
    checks: [['cat /data/log.txt', 'abcd']],
  },
  {
    capability: 'append-preserves',
    spelling: 'std.open',
    line: `node -e "const w = std.open('/data/keep.txt', 'a'); w.puts('Z'); w.close()"`,
    setup: ['echo -n a > /data/keep.txt'],
    checks: [['cat /data/keep.txt', 'aZ']],
  },
]

async function world(runtime: string): Promise<Workspace> {
  const parser = await getTestParser()
  const ops = new OpsRegistry()
  const data = new RAMResource()
  const other = new RAMResource()
  const ro = new RAMResource()
  ops.registerResource(data)
  ops.registerResource(other)
  ops.registerResource(ro)
  const ws = new Workspace(
    {},
    { mode: MountMode.EXEC, ops, shellParser: parser, runtimes: [runtime, 'vfs'] },
  )
  ws.addMount('/data', data, MountMode.WRITE)
  ws.addMount('/other', other, MountMode.WRITE)
  ws.addMount('/ro', ro, MountMode.READ)
  return ws
}

async function runRow(ws: Workspace, row: Row): Promise<void> {
  for (const s of row.setup ?? []) {
    const io = await ws.execute(s)
    expect(io.exitCode, `setup failed: ${s} -> ${stderrStr(io)}`).toBe(0)
  }
  const io = await ws.execute(row.line)
  expect(io.exitCode, `${row.line} -> ${stderrStr(io)}`).toBe(row.exitCode ?? 0)
  if (row.lineOut !== undefined) expect(stdoutStr(io)).toContain(row.lineOut)
  for (const [cmd, want] of row.checks ?? []) {
    const check = await ws.execute(cmd)
    // An absence assertion over the stdout of a command that failed is
    // vacuous: a mount the mutation damaged answers nothing, and "x is
    // gone" then holds for every x.
    expect(check.exitCode, `check failed: ${cmd} -> ${stderrStr(check)}`).toBe(0)
    const out = stdoutStr(check)
    if (want.startsWith('!')) {
      expect(out, `${cmd} still shows ${want.slice(1)}`).not.toContain(want.slice(1))
    } else {
      expect(out, `${cmd} does not show ${want}`).toContain(want)
    }
  }
}

// The boot line runs the interpreter once before any row seeds a file,
// so every seed is post-boot whatever order (or subset) the rows run
// in. Pyodide preloads mount prefixes into MEMFS at boot, and a row
// outcome must not depend on whether its seed made that snapshot.
function conformance(label: string, runtime: string, boot: string, rows: Row[]): void {
  describe(label, () => {
    let ws: Workspace
    beforeAll(async () => {
      ws = await world(runtime)
      const io = await ws.execute(boot)
      expect(io.exitCode, `boot failed: ${stderrStr(io)}`).toBe(0)
    }, 240_000)
    afterAll(async () => {
      await ws.close()
    })
    for (const row of rows) {
      const name = `${row.capability} via ${row.spelling}`
      if (row.broken === undefined) {
        it(name, () => runRow(ws, row), 120_000)
      } else {
        it.fails(`${name} [known broken]`, () => runRow(ws, row), 120_000)
      }
    }
  })
}

conformance('monty conformance', 'monty', 'python3 -c "pass"', MONTY_ROWS)
conformance('pyodide conformance', 'pyodide', 'python3 -c "pass"', PYODIDE_ROWS)
conformance('quickjs conformance', 'quickjs', 'node -e "1"', QUICKJS_ROWS)

interface CountingBridge {
  dispatch: BridgeDispatchFn
  files: Map<string, Uint8Array>
  mutationBytes: () => number
  mutationOps: () => string[]
}

function makeCountingBridge(seed: Record<string, string>): CountingBridge {
  const enc = new TextEncoder()
  const files = new Map<string, Uint8Array>()
  for (const [key, value] of Object.entries(seed)) files.set(key, enc.encode(value))
  const dirs = new Set<string>()
  const ops: [op: string, path: string, bytes: number][] = []
  const dispatch: BridgeDispatchFn = (op, path, bytes, dst) => {
    ops.push([op, path, bytes?.length ?? 0])
    if (op === 'READ') {
      const hit = files.get(path)
      if (hit === undefined) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(new Uint8Array(hit))
    }
    if (op === 'WRITE') {
      files.set(path, bytes === undefined ? new Uint8Array() : new Uint8Array(bytes))
      return Promise.resolve(undefined)
    }
    if (op === 'APPEND') {
      const base = files.get(path) ?? new Uint8Array()
      const tail = bytes ?? new Uint8Array()
      const next = new Uint8Array(base.length + tail.length)
      next.set(base)
      next.set(tail, base.length)
      files.set(path, next)
      return Promise.resolve(undefined)
    }
    if (op === 'STAT') {
      const hit = files.get(path)
      if (hit !== undefined) return Promise.resolve({ size: hit.length, isDir: false, mtimeMs: 0 })
      const dir = path.replace(/\/$/, '')
      const isDir = dirs.has(dir) || [...files.keys()].some((p) => p.startsWith(dir + '/'))
      if (isDir) return Promise.resolve({ size: 0, isDir: true, mtimeMs: 0 })
      return Promise.reject(new Error(`ENOENT ${path}`))
    }
    if (op === 'LIST') {
      const prefix = path.replace(/\/$/, '') + '/'
      const entries: { path: string; size: number; isDir: boolean }[] = []
      for (const [p, content] of files) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
          entries.push({ path: p, size: content.length, isDir: false })
        }
      }
      return Promise.resolve(entries)
    }
    if (op === 'UNLINK') {
      files.delete(path)
      return Promise.resolve(undefined)
    }
    if (op === 'MKDIR') {
      dirs.add(path)
      return Promise.resolve(undefined)
    }
    if (op === 'RMDIR') {
      dirs.delete(path)
      return Promise.resolve(undefined)
    }
    const moved = files.get(path)
    if (moved !== undefined && dst !== undefined) {
      files.delete(path)
      files.set(dst, moved)
    }
    return Promise.resolve(undefined)
  }
  // Both spellings count: the question is how many bytes crossed the
  // transport, and a runtime that ships tails is exactly the one being
  // measured. Counting WRITE alone would score a working append as 0.
  const isMutation = (op: string): boolean => op === 'WRITE' || op === 'APPEND'
  const mutationBytes = () =>
    ops.filter(([op]) => isMutation(op)).reduce((total, [, , size]) => total + size, 0)
  const mutationOps = () =>
    ops.filter(([op]) => isMutation(op)).map(([op, path]) => `${op} ${path}`)
  return { dispatch, files, mutationBytes, mutationOps }
}

const APPEND_LOOP_PY =
  "for i in range(8):\n    with open('/data/log.txt', 'a') as f:\n        f.write('xyz')"
const APPEND_LOOP_JS =
  "for (let i = 0; i < 8; i++) { const w = std.open('/data/log.txt', 'a'); w.puts('xyz'); w.close() }"

function runArgs(code: string): RunArgs {
  return { code, args: [], env: {}, stdin: null }
}

// Eight appends of three bytes must ship 24 bytes, not O(n^2). The
// dispatch is counted rather than the outcome compared: an amplifying
// runtime still produces the right final content, so the file alone
// cannot tell one append from a full rewrite per close.
describe('append ships only the deltas', () => {
  it.fails(
    `monty [${MONTY_OPEN_UNSUPPORTED}]`,
    async () => {
      const counting = makeCountingBridge({ '/data/log.txt': 'S'.repeat(64) })
      const rt = new MontyRuntime()
      rt.attach(counting.dispatch, () => ['/data/'])
      const result = await rt.run(runArgs(APPEND_LOOP_PY))
      await rt.close()
      expect(result.exitCode).toBe(0)
      expect(counting.mutationBytes(), counting.mutationOps().join(', ')).toBe(24)
    },
    120_000,
  )

  it('pyodide', async () => {
    const counting = makeCountingBridge({ '/data/log.txt': 'S'.repeat(64) })
    const rt = new PyodideRuntime()
    rt.attach(counting.dispatch, () => ['/data/'])
    const result = await rt.run(runArgs(APPEND_LOOP_PY))
    await rt.close()
    expect(result.exitCode).toBe(0)
    const dec = new TextDecoder()
    expect(dec.decode(counting.files.get('/data/log.txt'))).toBe('S'.repeat(64) + 'xyz'.repeat(8))
    expect(counting.mutationBytes(), counting.mutationOps().join(', ')).toBe(24)
  }, 120_000)

  it('quickjs', async () => {
    const counting = makeCountingBridge({ '/data/log.txt': 'S'.repeat(64) })
    const rt = new QuickJsRuntime()
    rt.attach(counting.dispatch, () => ['/data/'])
    const result = await rt.run(runArgs(APPEND_LOOP_JS))
    await rt.close()
    expect(result.exitCode).toBe(0)
    const dec = new TextDecoder()
    expect(dec.decode(counting.files.get('/data/log.txt'))).toBe('S'.repeat(64) + 'xyz'.repeat(8))
    expect(counting.mutationBytes(), counting.mutationOps().join(', ')).toBe(24)
  }, 120_000)
})
