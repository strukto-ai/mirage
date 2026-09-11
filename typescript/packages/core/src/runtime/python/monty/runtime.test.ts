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

import { afterAll, describe, expect, it } from 'vitest'
import type { BridgeDispatchFn } from '../../types.ts'
import { MontyRuntime } from './index.ts'
import { PyodideRuntime } from '../pyodide.ts'
import { buildRuntime } from '../../table.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { ContentType, FileStat, FileType, MountMode } from '../../../types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { PrefixResolver } from '../../resolver.ts'

function makeBridge(
  seed: Record<string, Uint8Array>,
  opts: { appendOp?: boolean } = {},
): {
  dispatch: BridgeDispatchFn
  files: Map<string, Uint8Array>
  writes: [string, Uint8Array][]
  mutations: string[]
  creates: string[]
  truncates: string[]
  appends: [string, Uint8Array][]
  mkdirAttrs: (Record<string, unknown> | undefined)[]
} {
  const files = new Map(Object.entries(seed))
  const dirs = new Set<string>()
  const writes: [string, Uint8Array][] = []
  const mutations: string[] = []
  const creates: string[] = []
  const truncates: string[] = []
  const appends: [string, Uint8Array][] = []
  const mkdirAttrs: (Record<string, unknown> | undefined)[] = []
  const dispatch: BridgeDispatchFn = (op, path, bytes, dst, attrs) => {
    if (op === 'read') {
      const data = files.get(path)
      if (data === undefined) {
        // The real dispatcher rejects with coded fs errors (ENOENT et
        // al); the mock mirrors that contract.
        return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
      }
      return Promise.resolve(data)
    }
    if (op === 'write') {
      const data = bytes ?? new Uint8Array()
      files.set(path, data)
      writes.push([path, data])
      return Promise.resolve(undefined)
    }
    if (op === 'create') {
      files.set(path, new Uint8Array())
      creates.push(path)
      return Promise.resolve(undefined)
    }
    if (op === 'truncate') {
      files.set(path, new Uint8Array())
      truncates.push(path)
      return Promise.resolve(undefined)
    }
    if (op === 'append') {
      if (opts.appendOp === false) {
        // What a backend without the op really rejects with (S3
        // registers write but not append).
        return Promise.reject(
          Object.assign(new Error("no op 'append'"), { code: 'ENOTSUP', op: 'append' }),
        )
      }
      const data = bytes ?? new Uint8Array()
      const cur = files.get(path) ?? new Uint8Array()
      const merged = new Uint8Array(cur.length + data.length)
      merged.set(cur, 0)
      merged.set(data, cur.length)
      files.set(path, merged)
      appends.push([path, data])
      return Promise.resolve(undefined)
    }
    if (op === 'mkdir' || op === 'rmdir' || op === 'unlink') {
      if (op === 'unlink') files.delete(path)
      if (op === 'mkdir') {
        dirs.add(path)
        mkdirAttrs.push(attrs as Record<string, unknown> | undefined)
      }
      if (op === 'rmdir') dirs.delete(path)
      mutations.push(`${op} ${path}`)
      return Promise.resolve(undefined)
    }
    if (op === 'rename') {
      const data = files.get(path)
      if (data !== undefined && dst !== undefined) {
        files.delete(path)
        files.set(dst, data)
      }
      mutations.push(`rename ${path} ${dst ?? ''}`)
      return Promise.resolve(undefined)
    }
    // The door builds each row from a name plus one stat, so the double
    // answers both.
    if (op === 'stat') {
      const found = files.get(path)
      if (found === undefined) {
        return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
      }
      return Promise.resolve(
        new FileStat({
          name: path,
          size: found.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
        }),
      )
    }
    const prefix = path
    const entries: string[] = []
    for (const p of files.keys()) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) entries.push(p)
    }
    // A directory the run itself made lists slash-marked, the way
    // slash-marking backends answer their listings.
    for (const d of dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) entries.push(d + '/')
    }
    if (entries.length === 0) return Promise.reject(new Error(`no such dir: ${prefix}`))
    return Promise.resolve(entries)
  }
  return { dispatch, files, writes, mutations, creates, truncates, appends, mkdirAttrs }
}

function run(
  rt: MontyRuntime,
  code: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return rt.run({ code, args, env, stdin: null })
}

const text = (b: Uint8Array | null): string => (b === null ? '' : new TextDecoder().decode(b))

describe('MontyRuntime', () => {
  const runtimes: MontyRuntime[] = []
  const make = (
    dispatch?: Parameters<MontyRuntime['attach']>[0],
    listMounts: () => string[] = () => [],
  ): MontyRuntime => {
    const rt = new MontyRuntime()
    if (dispatch !== undefined) rt.attach(dispatch, new PrefixResolver(listMounts))
    runtimes.push(rt)
    return rt
  }

  afterAll(async () => {
    for (const rt of runtimes) await rt.close()
  })

  it('runs sandboxed code and captures stdout', async () => {
    const result = await run(make(), 'print(21 * 2)')
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('42\n')
    expect(text(result.stderr)).toBe('')
  }, 30_000)

  it('syntax errors surface as a traceback with exit 1', async () => {
    const result = await run(make(), 'def broken(')
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain('SyntaxError')
  }, 30_000)

  it('a deadline SIGKILLs the busy worker and reports exit 124', async () => {
    const rt = make()
    await expect(
      rt.run({ code: 'while True: pass', args: [], env: {}, stdin: null, timeoutSeconds: 0.3 }),
    ).rejects.toThrow(/monty: timed out after 0.3s/)
  }, 30_000)

  it('an aborted signal SIGKILLs the busy worker and reports exit 1', async () => {
    const rt = make()
    const ctrl = new AbortController()
    setTimeout(() => {
      ctrl.abort()
    }, 200)
    const result = await rt.run({
      code: 'while True: pass',
      args: [],
      env: {},
      stdin: null,
      signal: ctrl.signal,
    })
    expect(result.exitCode).toBe(1)
  }, 30_000)

  it('runtime errors keep prior stdout', async () => {
    const result = await run(make(), "print('before')\n1/0")
    expect(result.exitCode).toBe(1)
    expect(text(result.stdout)).toBe('before\n')
    expect(text(result.stderr)).toContain('ZeroDivisionError')
  }, 30_000)

  it('exposes args as the argv global', async () => {
    const result = await run(make(), 'print(argv[1:])', ['a', 'b'])
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe("['a', 'b']\n")
  }, 30_000)

  it('argv[0] is prog when the caller names the program', async () => {
    // A named caller (a CLI install) owns argv[0]; without one the
    // interpreter's own placeholder stands, as `python3 -c` expects.
    const named = await make().run({
      code: 'print(argv[0])',
      args: ['a'],
      prog: 'pager',
      env: {},
      stdin: null,
    })
    expect([named.exitCode, text(named.stdout)]).toEqual([0, 'pager\n'])
    const plain = await run(make(), 'print(argv[0])')
    expect(text(plain.stdout)).toBe('main.py\n')
  }, 30_000)

  it('exposes piped input as the stdin global', async () => {
    const result = await make().run({
      code: 'print(stdin.decode())',
      args: [],
      env: {},
      stdin: new TextEncoder().encode('piped'),
    })
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('piped\n')
  }, 30_000)

  it('the stdin global is None without a pipe', async () => {
    const result = await run(make(), 'print(stdin is None)')
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('True\n')
  }, 30_000)

  it('serves os.getenv from the run env only', async () => {
    const result = await run(make(), "import os\nprint(os.getenv('MY_VAR', 'unset'))", [], {
      MY_VAR: 'v1',
    })
    expect(text(result.stdout)).toBe('v1\n')
  }, 30_000)

  it('serves os.environ as a dict of the run env', async () => {
    // The same nine reads the python host answers, so a program can be
    // written against either. Declining the engine's os.environ call
    // used to raise "not supported in this environment" here only.
    const code = [
      'import os',
      "print(os.environ.get('K'))",
      "print(os.environ.get('nope', 'dflt'))",
      "print(os.environ['K'])",
      "print('K' in os.environ, 'nope' in os.environ)",
      'print(sorted(os.environ))',
      'print(sorted(os.environ.items()))',
      'print(len(os.environ))',
      'print(type(os.environ).__name__)',
    ].join('\n')
    const result = await run(make(), code, [], { K: 'v', OTHER: 'w' })
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe(
      [
        'v',
        'dflt',
        'v',
        'True False',
        "['K', 'OTHER']",
        "[('K', 'v'), ('OTHER', 'w')]",
        '2',
        'dict',
      ]
        .map((line) => line + '\n')
        .join(''),
    )
  }, 30_000)

  it('a missing os.environ key raises KeyError, not a runtime error', async () => {
    const code =
      "import os\ntry:\n    os.environ['nope']\nexcept KeyError as e:\n    print('KeyError', e)"
    const result = await run(make(), code, [], { K: 'v' })
    expect([result.exitCode, text(result.stdout)]).toEqual([0, "KeyError 'nope'\n"])
  }, 30_000)

  it('mutating os.environ cannot reach the host env', async () => {
    // The callback hands back a copy, like python's
    // OSAccess(environ=dict(environ)).
    const code = "import os\nos.environ['K'] = 'guest'\nprint(os.getenv('K'))"
    const result = await run(make(), code, [], { K: 'v' })
    expect([result.exitCode, text(result.stdout)]).toEqual([0, 'v\n'])
  }, 30_000)

  it('reads a virtual file through the bridge via pathlib', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new TextEncoder().encode('virtual') })
    const rt = make(dispatch)
    const result = await run(
      rt,
      "from pathlib import Path\nprint(Path('/s3/a.txt').read_text().upper())",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('VIRTUAL\n')
  }, 30_000)

  it('writes flush back through the bridge', async () => {
    const { dispatch, writes } = makeBridge({ '/s3/seed.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const result = await run(rt, "from pathlib import Path\nPath('/s3/out.txt').write_text('data')")
    expect(result.exitCode).toBe(0)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe('/s3/out.txt')
    expect(text(writes[0]?.[1] ?? new Uint8Array())).toBe('data')
  }, 30_000)

  // The bridge already carried these ops for the other runtimes; the
  // monty callback declined them, so a mkdir or unlink on a mounted
  // path died inside the sandbox's own in-memory tree and never
  // reached the mount. The python runtime routes all four.
  it('mkdir, rmdir and unlink route to the bridge', async () => {
    const { dispatch, mutations, files } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const result = await run(
      rt,
      "from pathlib import Path\nPath('/s3/sub').mkdir()\nPath('/s3/a.txt').unlink()\nPath('/s3/sub').rmdir()",
    )
    expect(result.exitCode).toBe(0)
    expect(mutations).toEqual(['mkdir /s3/sub', 'unlink /s3/a.txt', 'rmdir /s3/sub'])
    expect(files.has('/s3/a.txt')).toBe(false)
  }, 30_000)

  it('unlink after rename reaches the mount', async () => {
    const { dispatch, mutations, files } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const result = await run(
      rt,
      "from pathlib import Path\nPath('/s3/a.txt').rename('/s3/b.txt')\nPath('/s3/b.txt').unlink()",
    )
    expect(result.exitCode).toBe(0)
    expect(mutations).toEqual(['rename /s3/a.txt /s3/b.txt', 'unlink /s3/b.txt'])
    expect(files.has('/s3/b.txt')).toBe(false)
  }, 30_000)

  it('rename carries both paths to the bridge', async () => {
    const { dispatch, mutations, files } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const result = await run(rt, "from pathlib import Path\nPath('/s3/a.txt').rename('/s3/b.txt')")
    expect(result.exitCode).toBe(0)
    expect(mutations).toEqual(['rename /s3/a.txt /s3/b.txt'])
    expect(files.has('/s3/b.txt')).toBe(true)
  }, 30_000)

  // The dispatcher resolves the mount from the source alone and reads
  // the destination against that same backend, so a cross-mount rename
  // would drop the source and write the target into the wrong store.
  it('a rename across two mounts is refused, not dispatched', async () => {
    const { dispatch, mutations, files } = makeBridge({ '/a/f.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/a/', '/b/'])
    const result = await run(rt, "from pathlib import Path\nPath('/a/f.txt').rename('/b/f.txt')")
    expect(result.exitCode).toBe(1)
    expect(mutations).toEqual([])
    expect(files.has('/a/f.txt')).toBe(true)
  }, 30_000)

  it('a rename inside one mount still dispatches', async () => {
    const { dispatch, mutations } = makeBridge({ '/a/f.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/a/', '/b/'])
    const result = await run(rt, "from pathlib import Path\nPath('/a/f.txt').rename('/a/g.txt')")
    expect(result.exitCode).toBe(0)
    expect(mutations).toEqual(['rename /a/f.txt /a/g.txt'])
  }, 30_000)

  it('a rename leaving the mount view raises EXDEV without dispatching', async () => {
    // python routes the pair to the dispatcher, whose resolver refuses
    // a cross-mount move; a scratch destination is the same boundary.
    const { dispatch, mutations } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(
      rt,
      'from pathlib import Path\n' +
        'try:\n' +
        "    Path('/s3/a.txt').rename('/etc/b.txt')\n" +
        'except OSError as exc:\n' +
        "    print('typed:', exc)\n",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toContain('Errno 18')
    expect(mutations).toEqual([])
  }, 30_000)

  it('iterdir lists a virtual directory', async () => {
    const { dispatch } = makeBridge({
      '/s3/a.txt': new Uint8Array([1]),
      '/s3/b.txt': new Uint8Array([2]),
    })
    const rt = make(dispatch)
    const result = await run(
      rt,
      "from pathlib import Path\nprint(sorted(str(p) for p in Path('/s3').iterdir()))",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe("['/s3/a.txt', '/s3/b.txt']\n")
  }, 30_000)

  it('exists/is_file answer from the bridge', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const result = await run(
      rt,
      "from pathlib import Path\nprint(Path('/s3/a.txt').is_file(), Path('/s3/nope').exists())",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('True False\n')
  }, 30_000)

  it('host filesystem stays invisible', async () => {
    // The scratch tree misses, so the guest reads python's own
    // FileNotFoundError — the python host answers this exact type.
    const result = await run(
      make(),
      "from pathlib import Path\nprint(Path('/etc/passwd').read_text())",
    )
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain('FileNotFoundError')
  }, 30_000)

  it('eval keeps state per session id', async () => {
    const rt = make()
    await rt.eval('x = 40', { session: 's1' })
    const result = await rt.eval('print(x + 2)', { session: 's1' })
    expect(result.status).toBe('complete')
    expect(text(result.stdout)).toBe('42\n')
  }, 30_000)

  it('eval returns the last expression with inputs bound', async () => {
    const rt = make()
    const result = await rt.eval("ctx['a'] + 1", { inputs: { ctx: { a: 41 } } })
    expect(result.value).toBe(42)
    expect(result.status).toBe('complete')
  }, 30_000)

  it('eval folds dict values into plain objects, not Maps', async () => {
    const rt = make()
    const result = await rt.eval("{'deny': 'no', 'nested': [{'k': 1}]}")
    expect(result.value).toEqual({ deny: 'no', nested: [{ k: 1 }] })
  }, 30_000)

  it('a missing virtual file raises a typed FileNotFoundError in the guest', async () => {
    const { dispatch } = makeBridge({})
    const rt = make(dispatch)
    const result = await run(
      rt,
      'from pathlib import Path\n' +
        'try:\n' +
        "    Path('/ram/nope.txt').read_text()\n" +
        'except FileNotFoundError as exc:\n' +
        "    print('typed:', exc)\n",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toContain('typed:')
    expect(text(result.stdout)).toContain('/ram/nope.txt')
  }, 30_000)

  it('a failed mutation raises the typed guest exception, not a bare Error', async () => {
    // The real dispatcher rejects with coded fs errors (pinned in
    // dispatcher.test.ts), and monty picks the guest exception from
    // `err.name`, so an untranslated rejection is uncatchable.
    const failing =
      (code: string): BridgeDispatchFn =>
      (op, path) => {
        if (op === 'readdir') return Promise.resolve([])
        return Promise.reject(Object.assign(new Error(path), { code }))
      }
    const missing = await run(
      make(failing('ENOENT')),
      'from pathlib import Path\n' +
        'try:\n' +
        "    Path('/ram/gone.txt').unlink()\n" +
        'except FileNotFoundError as exc:\n' +
        "    print('typed:', exc)\n",
    )
    expect(missing.exitCode).toBe(0)
    expect(text(missing.stdout)).toContain('typed:')

    const taken = await run(
      make(failing('EEXIST')),
      'from pathlib import Path\n' +
        'try:\n' +
        "    Path('/ram/d').mkdir()\n" +
        'except FileExistsError as exc:\n' +
        "    print('typed:', exc)\n",
    )
    expect(taken.exitCode).toBe(0)
    expect(text(taken.stdout)).toContain('typed:')
  }, 30_000)

  it('a cross-mount rename raises a catchable OSError with EXDEV', async () => {
    const { dispatch, mutations } = makeBridge({ '/a/f.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/a/', '/b/'])
    const result = await run(
      rt,
      'from pathlib import Path\n' +
        'try:\n' +
        "    Path('/a/f.txt').rename('/b/f.txt')\n" +
        'except OSError as exc:\n' +
        "    print('typed:', exc)\n",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toContain('Errno 18')
    expect(text(result.stdout)).toContain('Invalid cross-device link')
    expect(mutations).toEqual([])
  }, 30_000)

  it('a missing virtual file surfaces as an error without poisoning the runtime', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch)
    const bad = await run(rt, "from pathlib import Path\nPath('/s3/missing.txt').read_text()")
    expect(bad.exitCode).toBe(1)
    expect(text(bad.stderr)).toContain('Error')
    const ok = await run(rt, 'print(1 + 1)')
    expect(ok.exitCode).toBe(0)
    expect(text(ok.stdout)).toBe('2\n')
  }, 30_000)

  it('reads outside the live mount view never reach the bridge', async () => {
    // The scratch tree owns unmounted paths: a read misses there
    // rather than probing the workspace, so a path the mount view
    // hides cannot leak through this runtime.
    const { dispatch } = makeBridge({ '/etc/passwd': new TextEncoder().encode('leak') })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(rt, "from pathlib import Path\nprint(Path('/etc/passwd').read_text())")
    expect(result.exitCode).toBe(1)
    expect(text(result.stdout)).not.toContain('leak')
    expect(text(result.stderr)).toContain('FileNotFoundError')
  }, 30_000)

  // CPython's open('w') leaves an empty file even when nothing is
  // written, so the effect fires at open, not at the first flush —
  // mirrors python's test_monty_open_* quartet.
  it("open 'w' creates a missing file at open", async () => {
    const { dispatch, creates, files } = makeBridge({ '/s3/seed.txt': new Uint8Array([1]) })
    const result = await run(make(dispatch), "open('/s3/new.txt', 'w').close()")
    expect(result.exitCode).toBe(0)
    expect(creates).toEqual(['/s3/new.txt'])
    expect(files.get('/s3/new.txt')).toEqual(new Uint8Array())
  }, 30_000)

  it("open 'w' truncates an existing file at open", async () => {
    const { dispatch, truncates, files } = makeBridge({
      '/s3/keep.txt': new TextEncoder().encode('old-bytes'),
    })
    const result = await run(make(dispatch), "open('/s3/keep.txt', 'w').close()")
    expect(result.exitCode).toBe(0)
    expect(truncates).toEqual(['/s3/keep.txt'])
    expect(files.get('/s3/keep.txt')).toEqual(new Uint8Array())
  }, 30_000)

  it("open 'a' creates a missing file at open", async () => {
    const { dispatch, creates } = makeBridge({ '/s3/seed.txt': new Uint8Array([1]) })
    const result = await run(make(dispatch), "open('/s3/log.txt', 'a').close()")
    expect(result.exitCode).toBe(0)
    expect(creates).toEqual(['/s3/log.txt'])
  }, 30_000)

  it("open 'r' establishes nothing", async () => {
    const { dispatch, creates, truncates } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const result = await run(make(dispatch), "open('/s3/a.txt').close()")
    expect(result.exitCode).toBe(0)
    expect(creates).toEqual([])
    expect(truncates).toEqual([])
  }, 30_000)

  it('reads a mounted file through the open builtin, text and bytes', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new TextEncoder().encode('virtual') })
    const rt = make(dispatch)
    const asText = await run(rt, "print(open('/s3/a.txt').read())")
    expect([asText.exitCode, text(asText.stdout)]).toEqual([0, 'virtual\n'])
    const asBytes = await run(rt, "print(open('/s3/a.txt', 'rb').read())")
    expect([asBytes.exitCode, text(asBytes.stdout)]).toEqual([0, "b'virtual'\n"])
  }, 30_000)

  it('an append carries the delta, never the whole file', async () => {
    // Monty hands the append hook the new text alone; re-sending the
    // accumulated content would make a write loop quadratic against
    // the backend (python's test_monty_append_sends_only_the_new_bytes).
    const { dispatch, appends, writes, files } = makeBridge({
      '/s3/log.txt': new TextEncoder().encode('a'),
    })
    const result = await run(
      make(dispatch),
      "for part in ['b', 'c', 'd']:\n" +
        "    with open('/s3/log.txt', 'a') as f:\n" +
        '        f.write(part)',
    )
    expect(result.exitCode).toBe(0)
    expect(text(files.get('/s3/log.txt') ?? new Uint8Array())).toBe('abcd')
    expect(appends.map(([p, b]) => [p, text(b)])).toEqual([
      ['/s3/log.txt', 'b'],
      ['/s3/log.txt', 'c'],
      ['/s3/log.txt', 'd'],
    ])
    expect(writes).toEqual([])
  }, 30_000)

  it('append falls back to whole-file writes when the mount has no append op', async () => {
    const { dispatch, appends, writes, files } = makeBridge(
      { '/s3/log.txt': new TextEncoder().encode('a') },
      { appendOp: false },
    )
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(
      rt,
      "for part in ['b', 'c']:\n" +
        "    with open('/s3/log.txt', 'a') as f:\n" +
        '        f.write(part)',
    )
    expect(result.exitCode).toBe(0)
    expect(appends).toEqual([])
    expect(text(files.get('/s3/log.txt') ?? new Uint8Array())).toBe('abc')
    // One failed probe per mount, then whole-content writes.
    expect(writes.map(([p, b]) => [p, text(b)])).toEqual([
      ['/s3/log.txt', 'ab'],
      ['/s3/log.txt', 'abc'],
    ])
  }, 30_000)

  it('mkdir forwards parents to the mount and honors exist_ok locally', async () => {
    const { dispatch, mutations, mkdirAttrs } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(
      rt,
      'from pathlib import Path\n' +
        "Path('/s3/x/y').mkdir(parents=True)\n" +
        "Path('/s3/x/y').mkdir(exist_ok=True)\n" +
        "print('ok')",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('ok\n')
    expect(mutations).toEqual(['mkdir /s3/x/y'])
    expect(mkdirAttrs).toEqual([{ parents: true }])
  }, 30_000)

  it('mkdir without exist_ok raises on an existing directory', async () => {
    const { dispatch, mutations } = makeBridge({ '/s3/sub/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(rt, "from pathlib import Path\nPath('/s3/sub').mkdir()")
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain('FileExistsError')
    expect(mutations).toEqual([])
  }, 30_000)

  it('mkdir on a file raises even under exist_ok', async () => {
    // exist_ok forgives a directory, never a file — pathlib's own rule
    // (python's test_monty_mkdir_on_a_file_raises_even_under_exist_ok).
    const { dispatch, mutations } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(rt, "from pathlib import Path\nPath('/s3/a.txt').mkdir(exist_ok=True)")
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain('FileExistsError')
    expect(mutations).toEqual([])
  }, 30_000)

  it('a path under no mount is real scratch space, like python', async () => {
    // Python's own scratch semantics, probed: writing needs the parent
    // directory first (the tree starts holding only '/'), and after a
    // mkdir the whole file API works there.
    const { dispatch, writes, mutations } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make(dispatch, () => ['/s3/'])
    const result = await run(
      rt,
      'from pathlib import Path\n' +
        "Path('/tmp').mkdir()\n" +
        "f = open('/tmp/notes.txt', 'w')\n" +
        "f.write('alpha')\n" +
        'f.close()\n' +
        "with open('/tmp/notes.txt', 'a') as g:\n" +
        "    g.write('-beta')\n" +
        "print(open('/tmp/notes.txt').read())\n" +
        "Path('/tmp/d').mkdir()\n" +
        "Path('/tmp/d/x.txt').write_text('deep')\n" +
        "print(Path('/tmp/d/x.txt').read_text())\n" +
        "print(sorted(str(p) for p in Path('/tmp').iterdir()))\n" +
        "print(Path('/tmp/gone').exists(), Path('/tmp/notes.txt').is_file())\n" +
        "Path('/tmp/notes.txt').rename('/tmp/moved.txt')\n" +
        "print(Path('/tmp/moved.txt').read_text())",
    )
    expect(text(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe(
      "alpha-beta\ndeep\n['/tmp/d', '/tmp/notes.txt']\nFalse True\nalpha-beta\n",
    )
    // Scratch traffic never mutates the workspace.
    expect(writes).toEqual([])
    expect(mutations).toEqual([])
  }, 30_000)

  it('scratch space works with no workspace attached at all', async () => {
    const result = await run(
      make(),
      'from pathlib import Path\n' +
        "Path('/tmp').mkdir()\n" +
        "open('/tmp/s.txt', 'w').write('scratch')\n" +
        "print(open('/tmp/s.txt').read())\n" +
        "print(Path('/nope').exists())",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('scratch\nFalse\n')
  }, 30_000)

  it('a scratch write without its directory misses the way python does', async () => {
    // Probed on the python host: open('/tmp/x', 'w') with no prior
    // mkdir raises FileNotFoundError — the tree gives scratch space,
    // not a pre-made /tmp.
    const result = await run(make(), "open('/tmp/x.txt', 'w').write('hi')")
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain(
      "FileNotFoundError: [Errno 2] No such file or directory: '/tmp/x.txt'",
    )
  }, 30_000)

  it('serves the host clock: naive now, aware now, and today', async () => {
    const result = await run(
      make(),
      'from datetime import datetime, date, timezone\n' +
        'n = datetime.now()\n' +
        'print(n.year >= 2025, n.tzinfo)\n' +
        'a = datetime.now(timezone.utc)\n' +
        'print(a.tzinfo)\n' +
        't = date.today()\n' +
        'print(t.year >= 2025)',
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('True None\nUTC\nTrue\n')
  }, 30_000)

  it('resolve and absolute answer lexically, a str like python', async () => {
    const result = await run(
      make(),
      'from pathlib import Path\n' +
        "r = Path('rel/x.txt').resolve()\n" +
        'print(type(r).__name__, r)\n' +
        "a = Path('/abs/y.txt').absolute()\n" +
        'print(type(a).__name__, a)',
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('str /rel/x.txt\nstr /abs/y.txt\n')
  }, 30_000)

  it('a dead worker maps to exit 1 with a note, and eval propagates it', async () => {
    // python's MontyCrashedError cannot be constructed from python
    // (the binding seals it), so this mapping is pinned here only; the
    // JS class is public and a fake pool injects the rejection.
    const monty = (await import('@pydantic/monty')) as unknown as {
      MontyCrashedError: new (message: string, options?: { timedOut?: boolean }) => Error
    }
    const crashed = (boom: Error) => ({
      checkout: () =>
        Promise.resolve({
          workerPid: undefined,
          feedRun: () => Promise.reject(boom),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
    })
    const rt = make()
    ;(rt as unknown as { pool: unknown }).pool = crashed(
      new monty.MontyCrashedError('worker gone', { timedOut: false }),
    )
    const dead = await run(rt, 'print(1)')
    expect(dead.exitCode).toBe(1)
    expect(text(dead.stderr)).toBe('monty: worker crashed\n')

    const timedOut = make()
    ;(timedOut as unknown as { pool: unknown }).pool = crashed(
      new monty.MontyCrashedError('watchdog', { timedOut: true }),
    )
    const late = await run(timedOut, 'print(1)')
    expect(late.exitCode).toBe(1)
    expect(text(late.stderr)).toBe('monty: worker timed out\n')
    // eval mirrors python's: the crash propagates to the caller.
    await expect(timedOut.eval('1')).rejects.toBeInstanceOf(monty.MontyCrashedError)
  }, 30_000)

  it('has the monty name', () => {
    expect(make().name).toBe('monty')
  })
})

describe('Workspace with the monty runtime', () => {
  it('python3 reads a virtualized file end to end', async () => {
    const parser = await getTestParser()
    const data = new RAMResource()
    const ws = new Workspace(
      { '/data': data },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: ['monty', 'vfs'] },
    )
    await ws.execute('echo virtual-content > /data/a.txt')
    const io = await ws.execute(
      'python3 -c "from pathlib import Path; print(Path(\'/data/a.txt\').read_text().strip().upper())"',
    )
    expect(new TextDecoder().decode(io.stderr)).toBe('')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toBe('VIRTUAL-CONTENT\n')
    const io2 = await ws.execute(
      "python3 -c \"from pathlib import Path; Path('/data/out.txt').write_text('from-monty')\"",
    )
    expect(io2.exitCode).toBe(0)
    const io3 = await ws.execute('cat /data/out.txt')
    expect(new TextDecoder().decode(io3.stdout)).toBe('from-monty')
    // The open() builtin, end to end: establish + append on a mount,
    // and a /tmp path served by the per-run scratch tree.
    const io4 = await ws.execute(
      "python3 -c \"h = open('/data/log.txt', 'w'); h.write('first'); h.close(); print(open('/data/log.txt').read())\"",
    )
    expect(new TextDecoder().decode(io4.stderr)).toBe('')
    expect(new TextDecoder().decode(io4.stdout)).toBe('first\n')
    const io5 = await ws.execute('cat /data/log.txt')
    expect(new TextDecoder().decode(io5.stdout)).toBe('first')
    const io6 = await ws.execute(
      "python3 -c \"from pathlib import Path; Path('/tmp').mkdir(); open('/tmp/s.txt', 'w').write('tmp-side'); print(open('/tmp/s.txt').read())\"",
    )
    expect(new TextDecoder().decode(io6.stderr)).toBe('')
    expect(new TextDecoder().decode(io6.stdout)).toBe('tmp-side\n')
    await ws.close()
  }, 60_000)
})

describe('monty unavailable', () => {
  it('handlePython maps MontyUnavailableError to exit 127', async () => {
    const { handlePython } = await import('../../../workspace/executor/python/handle.ts')
    const { MontyUnavailableError } = await import('./index.ts')
    const runtime = {
      name: 'monty',
      captures: ['python3', 'python'],
      language: 'python' as const,
      reach: 'vfs' as const,
      config: {},
      attach: () => undefined,
      run: () => Promise.reject(new MontyUnavailableError('install @pydantic/monty')),
      close: () => Promise.resolve(),
    }
    const dispatch = (() => Promise.reject(new Error('unused'))) as never
    const [, io] = await handlePython(
      dispatch,
      null,
      [],
      { stdin: null, env: {}, code: 'print(1)' },
      { runtime },
    )
    expect(io.exitCode).toBe(127)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toContain('@pydantic/monty')
  })
})

describe('buildRuntime', () => {
  it('builds pyodide by name', () => {
    expect(buildRuntime('pyodide')).toBeInstanceOf(PyodideRuntime)
  })

  it('builds monty by name', () => {
    expect(buildRuntime('monty')).toBeInstanceOf(MontyRuntime)
  })

  it('rejects unknown names', () => {
    expect(() => buildRuntime('docker')).toThrow(/unknown runtime/)
  })

  it("hints that 'local' lives in the node package", () => {
    expect(() => buildRuntime('local')).toThrow(/mirage-node/)
  })
})

describe('python3 option table (CPython-pinned)', () => {
  async function run(line: string) {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: ['monty', 'vfs'] },
    )
    try {
      return await ws.execute(line)
    } finally {
      await ws.close()
    }
  }

  it('takes -u before a script as a flag, not as the script', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: ['monty', 'vfs'] },
    )
    try {
      await ws.execute("printf 'print(42)\\n' > /s.py")
      const io = await ws.execute('python3 -u /s.py')
      expect(io.exitCode).toBe(0)
      expect(new TextDecoder().decode(io.stdout)).toBe('42\n')
    } finally {
      await ws.close()
    }
  })

  it('exits 2 naming the letter for an unknown short option', async () => {
    const io = await run("python3 -zz -c 'print(1)'")
    expect(io.exitCode).toBe(2)
    expect(new TextDecoder().decode(io.stderr)).toContain('Unknown option: -z')
  })

  it("exits 2 with CPython's wording when a payload has no argument", async () => {
    const io = await run('python3 -c')
    expect(io.exitCode).toBe(2)
    const err = new TextDecoder().decode(io.stderr)
    expect(err).toContain('Argument expected for the -c option')
    expect(err).toContain('usage: python3 [option] ...')
  })

  it('sets argv[0] to the script as typed', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: ['monty', 'vfs'] },
    )
    try {
      await ws.execute("printf 'print(argv[0])\\n' > /s.py")
      const io = await ws.execute('python3 /s.py')
      expect(new TextDecoder().decode(io.stdout)).toBe('/s.py\n')
    } finally {
      await ws.close()
    }
  })

  it('sets argv[0] to -c under a payload', async () => {
    const io = await run("python3 -c 'print(argv[0])'")
    expect(new TextDecoder().decode(io.stdout)).toBe('-c\n')
  })

  it('refuses -m on a runtime with no import system', async () => {
    const io = await run('python3 -m json.tool')
    expect(io.exitCode).toBe(1)
    const err = new TextDecoder().decode(io.stderr)
    expect(err).toContain('-m')
    expect(err).toContain('monty')
  })

  it('warns on an init switch monty cannot honor', async () => {
    const io = await run("python3 -O -c 'print(1)'")
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stderr)).toContain("-O is ignored by the 'monty' runtime")
  })

  it('does not warn for the by-design no-ops', async () => {
    const io = await run("python3 -u -q -c 'print(1)'")
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stderr)).toBe('')
  })
})
