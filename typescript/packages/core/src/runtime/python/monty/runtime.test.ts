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

import { WorkspaceBinding } from '../../binding.ts'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { BridgeDispatchFn } from '../../types.ts'
import { MontyRuntime } from './index.ts'
import { MontyUnavailableError } from './errors.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
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
  appends: [string, Uint8Array][]
} {
  const files = new Map(Object.entries(seed))
  const dirs = new Set<string>()
  const writes: [string, Uint8Array][] = []
  const mutations: string[] = []
  const appends: [string, Uint8Array][] = []
  const dispatch: BridgeDispatchFn = (op, path, bytes, dst) => {
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
      return Promise.resolve(undefined)
    }
    if (op === 'truncate') {
      files.set(path, new Uint8Array())
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
      if (op === 'mkdir') dirs.add(path)
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
      if (dirs.has(path))
        return Promise.resolve(new FileStat({ name: path, type: FileType.DIRECTORY }))
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
    if (entries.length === 0 && !dirs.has(prefix.replace(/\/$/, ''))) {
      return Promise.reject(Object.assign(new Error(`no such dir: ${prefix}`), { code: 'ENOENT' }))
    }
    return Promise.resolve(entries)
  }
  return { dispatch, files, writes, mutations, appends }
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
    dispatch?: WorkspaceBinding['dispatch'],
    listMounts: () => string[] = () => [],
  ): MontyRuntime => {
    const rt = new MontyRuntime()
    if (dispatch !== undefined)
      rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(listMounts)))
    runtimes.push(rt)
    return rt
  }

  afterAll(async () => {
    for (const rt of runtimes) await rt.close()
  })

  // A program's whole answer: what it prints, its exit code, and a
  // phrase its stderr carries (null: nothing on stderr). The env rows
  // read a copy of the run env, like python's MontyFs keeps
  // dict(environ); the clock rows read the host clock; resolve() and
  // absolute() are lexical, a str like python.
  it.each<
    [
      string,
      { code: string; args?: string[]; env?: Record<string, string>; stdin?: string },
      number,
      string,
      string | null,
    ]
  >([
    ['print', { code: 'print(21 * 2)' }, 0, '42\n', null],
    ['syntax', { code: 'def broken(' }, 1, '', 'SyntaxError'],
    ['error keeps stdout', { code: "print('before')\n1/0" }, 1, 'before\n', 'ZeroDivisionError'],
    ['argv', { code: 'print(argv[1:])', args: ['a', 'b'] }, 0, "['a', 'b']\n", null],
    ['stdin', { code: 'print(stdin.decode())', stdin: 'piped' }, 0, 'piped\n', null],
    ['no stdin', { code: 'print(stdin is None)' }, 0, 'True\n', null],
    [
      'run env',
      { code: "import os\nprint(os.getenv('MY_VAR', 'unset'))", env: { MY_VAR: 'v1' } },
      0,
      'v1\n',
      null,
    ],
    [
      'missing env key',
      {
        code: "import os\ntry:\n    os.environ['nope']\nexcept KeyError as e:\n    print('KeyError', e)",
        env: { K: 'v' },
      },
      0,
      "KeyError 'nope'\n",
      null,
    ],
    [
      'env mutation stays in the guest',
      { code: "import os\nos.environ['K'] = 'guest'\nprint(os.getenv('K'))", env: { K: 'v' } },
      0,
      'v\n',
      null,
    ],
    [
      'host clock',
      {
        code:
          'from datetime import datetime, date, timezone\n' +
          'n = datetime.now()\n' +
          'print(n.year >= 2025, n.tzinfo)\n' +
          'a = datetime.now(timezone.utc)\n' +
          'print(a.tzinfo)\n' +
          't = date.today()\n' +
          'print(t.year >= 2025)',
      },
      0,
      'True None\nUTC\nTrue\n',
      null,
    ],
    [
      'lexical resolve',
      {
        code:
          'from pathlib import Path\n' +
          "r = Path('rel/x.txt').resolve()\n" +
          'print(type(r).__name__, r)\n' +
          "a = Path('/abs/y.txt').absolute()\n" +
          'print(type(a).__name__, a)',
      },
      0,
      'str /rel/x.txt\nstr /abs/y.txt\n',
      null,
    ],
  ])(
    'runs a program: %s',
    async (_name, program, exitCode, stdout, stderr) => {
      const result = await make().run({
        code: program.code,
        args: program.args ?? [],
        env: program.env ?? {},
        stdin: program.stdin === undefined ? null : new TextEncoder().encode(program.stdin),
      })
      expect([result.exitCode, text(result.stdout)]).toEqual([exitCode, stdout])
      if (stderr === null) expect(text(result.stderr)).toBe('')
      else expect(text(result.stderr)).toContain(stderr)
    },
    30_000,
  )

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

  it('a rename leaving the mount view raises EXDEV without dispatching', async () => {
    // The door refuses a pair on different mounts before dispatching,
    // and a destination outside the view is the same boundary.
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

  it('host filesystem stays invisible', async () => {
    // A path outside the view is refused with python's own
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

  it('inherits context cwd and honors an explicit run cwd', async () => {
    const rt = new MontyRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [rt, 'workspace'] },
    )
    try {
      expect((await ws.shell('mkdir /data/sub; cd /data')).exitCode).toBe(0)
      const code = 'import os; print(os.getcwd())'
      expect(text((await run(rt, code)).stdout)).toBe('/data\n')
      const explicit = await rt.run({
        code,
        args: [],
        env: {},
        stdin: null,
        cwd: PathSpec.fromStrPath('/data/sub'),
      })
      expect(text(explicit.stdout)).toBe('/data/sub\n')
    } finally {
      await ws.close()
    }
  })

  it('seeds eval cwd once per session', async () => {
    const rt = new MontyRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [rt, 'workspace'] },
    )
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/data')
      const first = await rt.eval('import os; os.getcwd()', { session: 'a' })
      expect(first.exitCode, text(first.stderr)).toBe(0)
      expect(first.value).toBe('/data')
      expect((await ws.shell('cd /')).exitCode).toBe(0)
      expect((await rt.eval("open('sub/item').read()", { session: 'a' })).value).toBe('child\n')
      expect((await rt.eval('import os; os.getcwd()', { session: 'b' })).value).toBe('/')
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/')
    } finally {
      await ws.close()
    }
  })

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

  // exist_ok forgives a directory, never a file — pathlib's own rule
  // (python's test_monty_mkdir_on_a_file_raises_even_under_exist_ok),
  // whether or not the guest read the file first.
  it.each([
    ['read first', "Path('/s3/a.txt').read_text()\n"],
    ['never read', ''],
  ])(
    'mkdir on a file raises even under exist_ok (%s)',
    async (_name, read) => {
      const { dispatch, mutations } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
      const rt = make(dispatch, () => ['/s3/'])
      const result = await run(
        rt,
        `from pathlib import Path\n${read}Path('/s3/a.txt').mkdir(exist_ok=True)`,
      )
      expect(result.exitCode).toBe(1)
      expect(text(result.stderr)).toContain('FileExistsError')
      expect(mutations).toEqual([])
    },
    30_000,
  )

  it('refuses a path no mount serves, as python does', async () => {
    // The only filesystem a guest sees is the workspace's: with nothing
    // mounted at /tmp, a directory cannot be made there and a file
    // cannot be written, and a probe answers False.
    for (const code of [
      "from pathlib import Path\nPath('/tmp').mkdir()",
      "open('/tmp/x.txt', 'w').write('hi')",
    ]) {
      const result = await run(make(), code)
      expect(result.exitCode).toBe(1)
      expect(text(result.stderr)).toContain(
        'FileNotFoundError: [Errno 2] No such file or directory',
      )
    }
    const probe = await run(make(), "from pathlib import Path\nprint(Path('/tmp').exists())")
    expect(probe.exitCode).toBe(0)
    expect(text(probe.stdout)).toBe('False\n')
  }, 30_000)

  it('a dead worker maps to exit 1 with a note, and eval propagates it', async () => {
    // python's MontyCrashedError cannot be constructed from python
    // (the engine seals it), so this mapping is pinned here only; the
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
    ;(rt as unknown as { execution: { pool: unknown } }).execution.pool = crashed(
      new monty.MontyCrashedError('worker gone', { timedOut: false }),
    )
    const dead = await run(rt, 'print(1)')
    expect(dead.exitCode).toBe(1)
    expect(text(dead.stderr)).toBe('monty: worker crashed\n')

    const timedOut = make()
    ;(timedOut as unknown as { execution: { pool: unknown } }).execution.pool = crashed(
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
  it('reports an unavailable version runtime as command not found', async () => {
    const runtime = new MontyRuntime()
    vi.spyOn(runtime, 'version').mockRejectedValue(
      new MontyUnavailableError('install @pydantic/monty'),
    )
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { shellParser: await getTestParser(), runtimes: [runtime, 'workspace'] },
    )
    try {
      const io = await ws.shell('python3 --version')
      expect(io.exitCode).toBe(127)
      expect(new TextDecoder().decode(io.stdout)).toBe('')
      expect(new TextDecoder().decode(io.stderr)).toBe('python3: install @pydantic/monty\n')
    } finally {
      await ws.close()
    }
  })

  it('does not print Mirage versions for unbound interpreter commands', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { shellParser: await getTestParser(), runtimes: ['workspace'] },
    )
    try {
      for (const name of ['python3', 'python', 'node', 'js']) {
        const io = await ws.shell(`${name} --version`)
        expect(io.exitCode).toBe(127)
        expect(new TextDecoder().decode(io.stdout)).toBe('')
        expect(new TextDecoder().decode(io.stderr)).toBe(`${name}: command not found\n`)
      }
    } finally {
      await ws.close()
    }
  })

  it('reports the guest Python version for --version and -V', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { shellParser: await getTestParser(), runtimes: ['monty', 'workspace'] },
    )
    try {
      for (const line of ['python3 --version', 'python -V', 'python3 -VV']) {
        const io = await ws.shell(line)
        expect(io.exitCode).toBe(0)
        expect(new TextDecoder().decode(io.stdout)).toBe('Python 3.14.0 (monty)\n')
        expect(new TextDecoder().decode(io.stderr)).toBe('')
      }
    } finally {
      await ws.close()
    }
  })
})

describe('monty unavailable', () => {
  it('handlePython maps MontyUnavailableError to exit 127', async () => {
    const { handlePython } = await import('../../../commands/builtin/general/python.ts')
    const { MontyUnavailableError } = await import('./index.ts')
    class UnavailableMonty extends MontyRuntime {
      override run(): Promise<never> {
        return Promise.reject(new MontyUnavailableError('install @pydantic/monty'))
      }
      override version(): Promise<never> {
        return this.run()
      }
    }
    const runtime = new UnavailableMonty()
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

describe('python3 option table (CPython-pinned)', () => {
  // Each row runs its setup lines, then one python3 line: what that
  // line exits with, prints, and says on stderr (every phrase listed,
  // or nothing at all for '').
  it.each<[string, string[], string, number, string | null, string[] | '']>([
    [
      'takes -u before a script as a flag, not as the script',
      ["printf 'print(42)\\n' > /s.py"],
      'python3 -u /s.py',
      0,
      '42\n',
      '',
    ],
    [
      'exits 2 naming the letter for an unknown short option',
      [],
      "python3 -zz -c 'print(1)'",
      2,
      null,
      ['Unknown option: -z'],
    ],
    [
      "exits 2 with CPython's wording when a payload has no argument",
      [],
      'python3 -c',
      2,
      null,
      ['Argument expected for the -c option', 'usage: python3 [option] ...'],
    ],
    [
      'sets argv[0] to the script as typed',
      ["printf 'print(argv[0])\\n' > /s.py"],
      'python3 /s.py',
      0,
      '/s.py\n',
      '',
    ],
    ['sets argv[0] to -c under a payload', [], "python3 -c 'print(argv[0])'", 0, '-c\n', ''],
    [
      'refuses -m on a runtime with no import system',
      [],
      'python3 -m json.tool',
      1,
      null,
      ['-m', 'monty'],
    ],
    [
      'warns on an init switch monty cannot honor',
      [],
      "python3 -O -c 'print(1)'",
      0,
      null,
      ["-O is ignored by the 'monty' runtime"],
    ],
    ['does not warn for the by-design no-ops', [], "python3 -u -q -c 'print(1)'", 0, null, ''],
  ])('%s', async (_name, setup, line, exitCode, stdout, stderr) => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: ['monty', 'workspace'],
      },
    )
    try {
      for (const step of setup) await ws.shell(step)
      const io = await ws.shell(line)
      const err = new TextDecoder().decode(io.stderr)
      expect(io.exitCode).toBe(exitCode)
      if (stdout !== null) expect(new TextDecoder().decode(io.stdout)).toBe(stdout)
      if (stderr === '') expect(err).toBe('')
      else for (const phrase of stderr) expect(err).toContain(phrase)
    } finally {
      await ws.close()
    }
  })
})
