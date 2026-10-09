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

import { WorkspaceBinding } from '../../../binding.ts'
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { PyodideRuntime } from '../runtime.ts'
import { PrefixResolver } from '../../../resolver.ts'
import { FileStat, FileType, Limit, MountMode } from '../../../../types.ts'
import type { BridgeDispatchFn, RunArgs } from '../../../types.ts'
import { CommandTimeoutError } from '../../../../errors/types.ts'
import { CLISpec } from '../../../../commands/cli/types.ts'
import { ScriptSource } from '../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../workspace/fixtures/workspace_fixture.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'

import { getCurrentSession, runWithSession } from '../../../../context/session_context.ts'
import { record, runWithRecording, startOp } from '../../../../observe/context.ts'
import { SessionState } from '../../../../workspace/session/session.ts'
import type * as asyncContextModule from '../../../../utils/async_context.ts'

vi.mock('../../../../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

const ENC = new TextEncoder()
const DEC = new TextDecoder()
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const runArgs = (code: string, args: string[] = []): RunArgs => ({
  code,
  args,
  env: {},
  stdin: null,
})

describe('Pyodide lazy VFS', { timeout: 60_000 }, () => {
  it.each(['first', 'bad', 'later'])(
    'fails the open whose truncate the mount refuses (%s)',
    async (rejected) => {
      const names = ['first', 'bad', 'later', 'after', 'last']
      const files = new Map<string, Uint8Array>(
        names.map((name) => [`/data/${name}`, ENC.encode('old')]),
      )
      const writes: string[] = []
      const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
        await Promise.resolve()
        const data = files.get(path)
        if (data === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' })
        if (op === 'stat')
          return new FileStat({ name: path, type: FileType.FILE, size: data.length })
        if (op === 'read') return data
        // A 'w' open empties the file, then its write lands at 0.
        if (op === 'truncate') {
          writes.push(path)
          if (path === `/data/${rejected}`) throw new Error('denied')
          files.set(path, new Uint8Array())
          return
        }
        if (op === 'pwrite') {
          files.set(path, bytes ?? new Uint8Array())
          return
        }
        throw new Error(`unexpected op: ${op}`)
      }
      const rt = new PyodideRuntime()
      rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
      try {
        const result = await rt.run(
          runArgs(
            readFileSync(new URL('./fixtures/py/discarded_writes.py', import.meta.url), 'utf8'),
          ),
        )
        const failedAt = names.indexOf(rejected)
        // The refused truncate fails the open that asked for it, so the
        // program stops there: what it wrote before landed at each close,
        // and nothing after it was attempted.
        expect(result.exitCode).toBe(1)
        const stderr = DEC.decode(result.stderr ?? new Uint8Array())
        expect(stderr).toContain(`OSError: [Errno 29] I/O error: '/data/${rejected}'`)
        expect(stderr).not.toContain('python3: failed to')
        expect(writes).toEqual(names.slice(0, failedAt + 1).map((name) => `/data/${name}`))
        for (const name of names.slice(0, failedAt))
          expect(DEC.decode(files.get(`/data/${name}`))).toBe('new')
        for (const name of names.slice(failedAt))
          expect(DEC.decode(files.get(`/data/${name}`))).toBe('old')
        const next = await rt.run(runArgs("with open('/data/last', 'w') as f: f.write('fresh')"))
        expect(next.exitCode).toBe(0)
        expect(DEC.decode(next.stderr ?? new Uint8Array())).toBe('')
        expect(DEC.decode(files.get('/data/last'))).toBe('fresh')
      } finally {
        await rt.close()
      }
    },
  )

  it('sends nothing more for a file whose write the mount refused until the file hears of it', async () => {
    const files = new Map<string, Uint8Array>(
      ['bad', 'good'].map((name) => [`/data/${name}`, ENC.encode('old')]),
    )
    const ops: string[] = []
    const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
      await Promise.resolve()
      ops.push(`${op} ${path}`)
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' })
      if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: data.length })
      if (op === 'read') return data
      if (op === 'pwrite') {
        if (path === '/data/bad') throw new Error('denied')
        files.set(path, bytes ?? new Uint8Array())
        return
      }
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
    try {
      const result = await rt.run(
        runArgs(
          [
            'import os',
            "bad = open('/data/bad', 'r+')",
            "good = open('/data/good', 'r+')",
            "bad.write('new'); bad.flush()",
            "good.write('new'); good.close()",
            'try:',
            "    os.rename('/data/bad', '/data/moved')",
            'except OSError as e:',
            "    print('rename', e.errno)",
            "print(os.path.exists('/data/bad'), os.path.exists('/data/moved'))",
            'bad.close()',
          ].join('\n'),
        ),
      )
      expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('')
      expect(result.exitCode).toBe(0)
      // The rename hears of the refused write and fails, so neither the
      // mount nor the guest moves the file.
      expect(DEC.decode(result.stdout)).toBe('rename 29\nTrue False\n')
      expect(ops.filter((op) => op.startsWith('rename'))).toEqual([])
      expect(DEC.decode(files.get('/data/bad'))).toBe('old')
      expect(DEC.decode(files.get('/data/good'))).toBe('new')
    } finally {
      await rt.close()
    }
  })

  it('refuses a console that started before its runtime was bound, and starts others', async () => {
    const rt = new PyodideRuntime()
    try {
      expect((await rt.eval('x = 1', { session: 'early' })).exitCode).toBe(0)
      rt.bind(
        new WorkspaceBinding(
          (_op, path) => Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' })),
          new PrefixResolver(() => ['/data/']),
        ),
      )
      await expect(rt.eval('print(x)', { session: 'early' })).rejects.toThrow(
        'pyodide console "early" started before this runtime was bound to a workspace, so it cannot reach the mounts; start a new console',
      )
      const late = await rt.eval("import os; print(os.path.isdir('/data'))", { session: 'late' })
      expect(DEC.decode(late.stdout)).toBe('True\n')
    } finally {
      await rt.close()
    }
  })

  it('drops the name of a mount a named console no longer sees', async () => {
    let prefixes = ['/data/', '/secret/']
    const dispatch: BridgeDispatchFn = (_op, path) =>
      Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => prefixes)))
    const names = "import os; print(sorted(n for n in os.listdir('/') if n in ('data', 'secret')))"
    try {
      expect(DEC.decode((await rt.eval(names, { session: 'one' })).stdout)).toBe(
        "['data', 'secret']\n",
      )
      prefixes = ['/data/']
      expect(DEC.decode((await rt.eval(names, { session: 'one' })).stdout)).toBe("['data']\n")
    } finally {
      await rt.close()
    }
  })

  it("fails only the close of the file whose write the mount refuses, not another file's", async () => {
    const files = new Map<string, Uint8Array>(
      ['bad', 'good', 'later'].map((name) => [`/data/${name}`, ENC.encode('old')]),
    )
    const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
      await Promise.resolve()
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' })
      if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: data.length })
      if (op === 'read') return data
      if (op === 'pwrite') {
        if (path === '/data/bad') throw new Error('denied')
        files.set(path, bytes ?? new Uint8Array())
        return
      }
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
    try {
      const result = await rt.run(
        runArgs(
          [
            "bad = open('/data/bad', 'r+')",
            "good = open('/data/good', 'r+')",
            "bad.write('new'); bad.flush()",
            "good.write('new'); good.flush()",
            'good.close()',
            'try:',
            '    bad.close()',
            'except OSError as e:',
            "    print('bad', e.errno)",
            "with open('/data/later', 'r+') as f: f.write('new')",
          ].join('\n'),
        ),
      )
      expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('bad 29\n')
      expect(DEC.decode(files.get('/data/bad'))).toBe('old')
      expect(DEC.decode(files.get('/data/good'))).toBe('new')
      expect(DEC.decode(files.get('/data/later'))).toBe('new')
    } finally {
      await rt.close()
    }
  })

  it.each([false, true])(
    'stops a timed-out script CLI and recovers (warm worker: %s)',
    async (warm) => {
      const rt = new PyodideRuntime()
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.EXEC, runtimes: [rt, 'workspace'], shellParser: await getTestParser() },
      )
      ws.registerCli(
        'spin',
        new CLISpec({
          name: 'spin',
          script: new ScriptSource('while True: pass'),
          runtime: 'pyodide',
          limit: new Limit({ timeoutSeconds: 0.1 }),
        }),
      )
      try {
        // Cover both cancellation during startup and an already executing guest.
        if (warm) expect((await ws.shell("python3 -c 'pass'")).exitCode).toBe(0)
        expect((await ws.shell('spin')).exitCode).toBe(124)
        const next = await ws.shell("python3 -c 'print(42)'")
        expect(next.exitCode).toBe(0)
        expect(DEC.decode(next.stdout)).toBe('42\n')
      } finally {
        await ws.close()
      }
    },
  )

  it('does no preload, reads only accessed bytes, and refreshes between sessions', async () => {
    const context = new AsyncLocalStorage<string>()
    const calls: { op: string; path: string; session: string | undefined }[] = []
    let bytes = new Uint8Array(200_000).fill(65)
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push({ op, path, session: context.getStore() })
      if (path !== '/data/one.bin') throw new Error(`unexpected access: ${op} ${path}`)
      if (op === 'stat')
        return new FileStat({ name: path, type: FileType.FILE, size: bytes.length })
      if (op === 'read') return bytes
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/', '/huge/'])))
    try {
      expect((await rt.run(runArgs('print(1)'))).exitCode).toBe(0)
      expect(calls).toEqual([])
      const first = await context.run('one', () =>
        rt.run(
          runArgs("data = open('/data/one.bin', 'rb').read(); print(len(data), data[0], data[-1])"),
        ),
      )
      expect(DEC.decode(first.stderr ?? new Uint8Array())).toBe('')
      expect(DEC.decode(first.stdout)).toBe('200000 65 65\n')
      expect(calls.every((c) => c.session === 'one')).toBe(true)
      expect(calls.filter((c) => c.op === 'read')).toHaveLength(1)
      calls.length = 0
      bytes = ENC.encode('fresh')
      const second = await context.run('two', () =>
        rt.run(runArgs("print(open('/data/one.bin').read())")),
      )
      expect(DEC.decode(second.stdout)).toBe('fresh\n')
      expect(calls.every((c) => c.session === 'two')).toBe(true)
      expect(calls.some((c) => c.op === 'readdir')).toBe(false)
    } finally {
      await rt.close()
    }
  })

  it('classifies a directory once and stats only the names a later listing adds', async () => {
    const stats: string[] = []
    let listings = 0
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await Promise.resolve()
      if (op === 'readdir' && path === '/data/') {
        listings += 1
        return listings === 1
          ? ['/data/a.txt', '/data/b.txt']
          : ['/data/a.txt', '/data/b.txt', '/data/late']
      }
      if (op === 'stat') {
        stats.push(path)
        if (path === '/data/late') return new FileStat({ name: path, type: FileType.DIRECTORY })
        if (path === '/data/a.txt' || path === '/data/b.txt')
          return new FileStat({ name: path, type: FileType.FILE, size: 1 })
      }
      throw Object.assign(new Error(path), { code: 'ENOENT' })
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
    try {
      const result = await rt.run(
        runArgs(
          "import os\nfirst = sorted(os.listdir('/data'))\nsecond = sorted(os.listdir('/data'))\n" +
            "print(first, second, [e.is_dir() for e in os.scandir('/data') if e.name == 'late'])",
        ),
      )
      expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('')
      expect(DEC.decode(result.stdout)).toBe(
        "['a.txt', 'b.txt'] ['a.txt', 'b.txt', 'late'] [True]\n",
      )
      expect(stats.sort()).toEqual(['/data/a.txt', '/data/b.txt', '/data/late'])
    } finally {
      await rt.close()
    }
  })

  it('keeps real files at standard stream paths on a /dev mount', async () => {
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await Promise.resolve()
      if (path === '/dev/stdin') {
        if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
        if (op === 'read') return ENC.encode('real')
      }
      throw Object.assign(new Error(path), { code: 'ENOENT' })
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/dev/'])))
    try {
      const result = await rt.run(runArgs("print(open('/dev/stdin').read())"))
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('real\n')
    } finally {
      await rt.close()
    }
  })

  it('reads a Notion glob without touching an unrelated 47,000-file mount', async () => {
    const catalog = Array.from({ length: 47_000 }, (_, i) => `/wandb/file-${String(i)}.json`)
    const calls: { op: string; path: string }[] = []
    let data = ENC.encode('{"name":"first"}')
    const target = '/notion/databases/demo/database.json'
    const directories = new Map([
      ['/notion/', ['/notion/databases/']],
      ['/notion/databases/', ['/notion/databases/demo/']],
      ['/notion/databases/demo/', [target]],
      ['/wandb/', catalog],
    ])
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await Promise.resolve()
      calls.push({ op, path })
      if (op === 'readdir') return directories.get(path) ?? []
      if (op === 'stat') {
        if (directories.has(path.replace(/\/$/, '') + '/'))
          return new FileStat({ name: path, type: FileType.DIRECTORY })
        if (path === target || path.startsWith('/wandb/file-'))
          return new FileStat({ name: path, type: FileType.FILE, size: data.length })
      }
      if (op === 'read' && path === target) return data
      if (op === 'read' && path.startsWith('/wandb/')) return ENC.encode('{}')
      throw Object.assign(new Error(path), { code: 'ENOENT' })
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/notion/', '/wandb/'])))
    try {
      const counts: number[] = []
      for (const name of ['first', 'second', 'third']) {
        data = ENC.encode(JSON.stringify({ name }))
        calls.length = 0
        const result = await rt.run(
          runArgs(readFileSync(new URL('./fixtures/py/lazy_glob.py', import.meta.url), 'utf8')),
        )
        expect(result.exitCode).toBe(0)
        expect(DEC.decode(result.stdout)).toBe(`${name}\n`)
        expect(calls.some((call) => call.path.startsWith('/wandb'))).toBe(false)
        expect(calls.filter((call) => call.op === 'read')).toEqual([{ op: 'read', path: target }])
        counts.push(calls.length)
      }
      expect(new Set(counts).size).toBe(1)
    } finally {
      await rt.close()
    }
  })

  it.each(['truncate', 'append'])(
    'flushes open descriptor %s writes before reads on another mount',
    async (mode) => {
      const files = new Map<string, Uint8Array>([['/data/file', ENC.encode('old')]])
      const observed: string[] = []
      const rt = new PyodideRuntime()
      rt.bind(
        new WorkspaceBinding(
          async (op, path, bytes) => {
            await Promise.resolve()
            if (op === 'readdir' && path === '/other/') {
              observed.push(DEC.decode(files.get('/data/file')))
              return []
            }
            if (op === 'stat') {
              const data = files.get(path)
              if (data === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' })
              return new FileStat({ name: path, type: FileType.FILE, size: data.length })
            }
            if (op === 'read') return files.get(path)
            if (op === 'truncate') {
              files.set(path, new Uint8Array())
              return
            }
            if (op === 'pwrite') {
              files.set(path, bytes ?? new Uint8Array())
              return
            }
            if (op === 'append') {
              files.set(path, ENC.encode(DEC.decode(files.get(path)) + DEC.decode(bytes)))
              return
            }
            throw new Error(`unexpected op: ${op} ${path}`)
          },
          new PrefixResolver(() => ['/data/', '/other/']),
        ),
      )
      try {
        const result = await rt.run(
          runArgs(
            readFileSync(new URL('./fixtures/py/descriptor_writes.py', import.meta.url), 'utf8'),
            [mode],
          ),
        )
        expect(result.exitCode).toBe(0)
        const start = mode === 'append' ? 'old' : ''
        expect(observed).toEqual([start + 'first+', start + 'first+second', start + 'first+second'])
        expect(DEC.decode(files.get('/data/file'))).toBe(start + 'first+second')
      } finally {
        await rt.close()
      }
    },
  )

  it.each([1, 2])(
    'preserves queued run and eval session attribution without async storage isolation (limit %s)',
    async (maxConcurrency) => {
      const calls: string[] = []
      const rt = new PyodideRuntime({ config: { maxConcurrency } })
      rt.bind(
        new WorkspaceBinding(
          async (op, path) => {
            await Promise.resolve()
            const session = getCurrentSession()?.sessionId ?? 'missing'
            calls.push(`${op}:${session}`)
            if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 3 })
            if (op === 'read') {
              record(op, path, 'test', 3, startOp())
              return ENC.encode(session)
            }
            throw new Error(`unexpected op: ${op}`)
          },
          new PrefixResolver(() => ['/data/']),
        ),
      )
      const one = new SessionState({ sessionId: 'one' })
      const two = new SessionState({ sessionId: 'two' })
      try {
        const first = runWithSession(one, () =>
          runWithRecording(() => rt.run(runArgs("print(open('/data/one').read())"))),
        )
        const second = runWithSession(two, () =>
          runWithRecording(() => rt.eval("open('/data/two').read()")),
        )
        const [[run, firstRecords], [evaluated, secondRecords]] = await Promise.all([first, second])
        expect(DEC.decode(run.stdout)).toBe('one\n')
        expect(evaluated.value).toBe('two')
        expect(calls).toEqual(['stat:one', 'read:one', 'stat:two', 'read:two'])
        expect(firstRecords.map((entry) => entry.path)).toEqual(['/data/one'])
        expect(secondRecords.map((entry) => entry.path)).toEqual(['/data/two'])
        expect(getCurrentSession()).toBeNull()
      } finally {
        await rt.close()
      }
    },
  )

  it.each(['abort', 'timeout'])(
    'drains a slow mutation before advancing after %s',
    async (kind) => {
      const entered = gate()
      const release = gate()
      let contents: Uint8Array = ENC.encode('old')
      const writes: string[] = []
      const rt = new PyodideRuntime()
      rt.bind(
        new WorkspaceBinding(
          async (op, path, bytes) => {
            if (op === 'stat')
              return new FileStat({ name: path, type: FileType.FILE, size: contents.length })
            if (op === 'read') return contents
            if (op === 'truncate') {
              contents = new Uint8Array()
              return
            }
            if (op === 'pwrite') {
              const value = DEC.decode(bytes)
              if (value === 'first') {
                entered.resolve()
                await release.promise
              }
              contents = bytes ?? new Uint8Array()
              writes.push(value)
              return
            }
            throw new Error(`unexpected op: ${op}`)
          },
          new PrefixResolver(() => ['/data/']),
        ),
      )
      try {
        await rt.run(runArgs('pass'))
        const controller = new AbortController()
        const first = rt.run({
          ...runArgs(
            "import os\nwith open('/data/file', 'w') as f: f.write('first')\nos.stat('/data/flush')",
          ),
          ...(kind === 'abort' ? { signal: controller.signal } : { timeoutSeconds: 0.1 }),
        })
        const checked =
          kind === 'timeout'
            ? expect(first).rejects.toBeInstanceOf(CommandTimeoutError)
            : first.then((result) => {
                expect(result.exitCode).toBe(1)
              })
        await entered.promise
        const next = rt.run(runArgs("with open('/data/file', 'w') as f: f.write('second')"))
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(writes).toEqual([])
        release.resolve()
        await checked
        expect((await next).exitCode).toBe(0)
        expect(writes).toEqual(['first', 'second'])
        expect(DEC.decode(contents)).toBe('second')
      } finally {
        release.resolve()
        await rt.close()
      }
    },
  )

  it('interrupts compute and a blocked file read, then keeps serving requests', async () => {
    const entered = gate()
    const release = gate()
    const dispatch: BridgeDispatchFn = async (op, path) => {
      if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
      if (op === 'read') {
        entered.resolve()
        await release.promise
        return ENC.encode('late')
      }
      throw new Error(`unexpected op: ${op}`)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
    try {
      await rt.run(runArgs('pass'))
      await expect(
        rt.run({ ...runArgs('while True: pass'), timeoutSeconds: 0.1 }),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, 100)
      const aborted = await rt.run({
        ...runArgs(
          readFileSync(new URL('./fixtures/py/slow_traceback.py', import.meta.url), 'utf8'),
        ),
        signal: controller.signal,
      })
      clearTimeout(timer)
      expect(aborted.exitCode).toBe(1)
      const blocked = expect(
        rt.run({ ...runArgs("open('/data/hang').read()"), timeoutSeconds: 0.1 }),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
      await entered.promise
      await new Promise((resolve) => setTimeout(resolve, 300))
      release.resolve()
      await blocked
      const fresh = await rt.run(runArgs('print(42)'))
      expect(fresh.exitCode).toBe(0)
      expect(DEC.decode(fresh.stdout)).toBe('42\n')
    } finally {
      release.resolve()
      await rt.close()
    }
  })
})
