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

import { readFileSync } from 'node:fs'
import type { Context } from '../../../commands/config.ts'
import type { Program, RunResult } from '../../types.ts'
import { PyodideWorkerClient } from './worker/client.ts'
import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { getCurrentSession, runWithSession } from '../../../context/session_context.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { PyodideRuntime } from './runtime.ts'
import { PrefixResolver } from '../../resolver.ts'
import { loadPyodideRuntime } from './loader.ts'
import { PyodideExecution } from './execution.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { context } from '../../../../tests/workspace/fixtures/context.ts'
import { bindOver, runContext } from '../../../../tests/runtime/fixtures/bridge.ts'

/** Run a resolved program; pyodide has no engine, so the run queues at the call. */
function interpret(
  rt: PyodideRuntime,
  program: Partial<Program> & { code: string },
  extra: Partial<Context> = {},
): Promise<RunResult> {
  return rt.interpret(undefined, { args: [], stdin: null, ...program }, runContext(rt, extra))
}

/** An empty cwd: the interpreter stays in the directory it started in. */
const NO_CWD = PathSpec.fromStrPath('')

/** The interpreter's working directory for a run given no cwd. */
async function defaultCwd(rt: PyodideRuntime): Promise<string> {
  const result = await interpret(rt, { code: 'import os; print(os.getcwd())' }, { cwd: NO_CWD })
  return new TextDecoder().decode(result.stdout).trim()
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Pyodide execution lifetime', { timeout: 120_000 }, () => {
  it.each(['inline', 'worker'] as const)('isolates commands (%s)', async (mode) => {
    const rt = new PyodideRuntime({ config: { autoLoadFromImports: false } })
    if (mode !== 'inline') {
      bindOver(
        rt,
        () => Promise.reject(new Error('unexpected filesystem operation')),
        new PrefixResolver(() => []),
      )
    }
    const mutate =
      "import builtins, json, sys, types; builtins.mirage_token = 42; json.mirage_token = 42; sys.modules['mirage_token'] = types.ModuleType('mirage_token')"
    const inspect =
      "import builtins, json, sys; print(hasattr(builtins, 'mirage_token'), hasattr(json, 'mirage_token'), 'mirage_token' in sys.modules)"
    const clean = 'False False False\n'
    const dec = new TextDecoder()
    try {
      const first = await interpret(rt, { code: mutate })
      expect(first.exitCode).toBe(0)
      const next = await interpret(rt, { code: inspect })
      expect(next.exitCode).toBe(0)
      expect(dec.decode(next.stdout)).toBe(clean)
    } finally {
      await rt.close()
    }
  })
})

describe('Pyodide concurrency', { timeout: 120_000 }, () => {
  it.each([1, 2])(
    'bounds calls and preserves close barriers (limit %s)',
    async (maxConcurrency) => {
      const rt = new PyodideRuntime({ config: maxConcurrency === 1 ? {} : { maxConcurrency } })
      const reads = new Map(
        ['one', 'two', 'three', 'four'].map(
          (name) => [name, { entered: gate(), release: gate() }] as const,
        ),
      )
      const create = vi.spyOn(PyodideWorkerClient, 'create')
      const pending: Promise<unknown>[] = []
      bindOver(
        rt,
        async (op, path, _bytes, _dst, attrs) => {
          if (attrs?.retained !== undefined) return attrs.retained
          if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 5 })
          const read = reads.get(path.slice('/data/'.length))
          if (op !== 'read' || read === undefined) throw new Error(`unexpected ${op}: ${path}`)
          read.entered.resolve()
          await read.release.promise
          return new TextEncoder().encode(getCurrentSession()?.sessionId ?? 'missing')
        },
        new PrefixResolver(() => ['/data/']),
      )
      const run = (name: string) =>
        runWithSession(new SessionState({ sessionId: name }), () =>
          interpret(rt, { code: `print(open('/data/${name}').read())` }),
        )
      try {
        const first = run('one')
        const second = runWithSession(new SessionState({ sessionId: 'two' }), () =>
          interpret(rt, { code: "open('/data/two').read(); raise ValueError('expected failure')" }),
        )
        const third = run('three')
        pending.push(first, second, third)
        if (maxConcurrency === 1) {
          const firstRead = await Promise.race(
            [...reads].map(async ([name, read]) => {
              await read.entered.promise
              return name
            }),
          )
          expect(firstRead).toBe('one')
        }
        await reads.get('one')?.entered.promise
        if (maxConcurrency === 2) await reads.get('two')?.entered.promise
        expect(create).toHaveBeenCalledTimes(maxConcurrency)
        let closed = false
        const closing = rt.close().then(() => {
          closed = true
        })
        const fourth = run('four')
        const closeAgain = rt.close()
        pending.push(closing, fourth, closeAgain)
        reads.get('one')?.release.resolve()
        if (maxConcurrency === 1) {
          await reads.get('two')?.entered.promise
          reads.get('two')?.release.resolve()
        }
        await reads.get('three')?.entered.promise
        expect(create).toHaveBeenCalledTimes(3)
        expect(closed).toBe(false)
        reads.get('two')?.release.resolve()
        reads.get('three')?.release.resolve()
        await closing
        await reads.get('four')?.entered.promise
        expect(closed).toBe(true)
        reads.get('four')?.release.resolve()
        const results = await Promise.all([first, third, fourth])
        expect(results.map((result) => new TextDecoder().decode(result.stdout))).toEqual([
          'one\n',
          'three\n',
          'four\n',
        ])
        expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0])
        const failure = await second
        expect(failure.exitCode).toBe(1)
        expect(new TextDecoder().decode(failure.stderr ?? new Uint8Array())).toContain(
          'expected failure',
        )
        await closeAgain
      } finally {
        for (const read of reads.values()) read.release.resolve()
        await Promise.allSettled(pending)
        await rt.close()
        create.mockRestore()
      }
    },
  )

  it.each(['abort', 'timeout'] as const)(
    'keeps another call running and releases its slot after %s',
    async (kind) => {
      const entered = gate()
      const started = gate()
      const release = gate()
      const rt = new PyodideRuntime({ config: { maxConcurrency: 2 } })
      bindOver(
        rt,
        async (op, path, _bytes, _dst, attrs) => {
          if (attrs?.retained !== undefined) return attrs.retained
          if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
          if (op !== 'read') throw new Error(`unexpected ${op}: ${path}`)
          if (path === '/data/started') {
            started.resolve()
            return new TextEncoder().encode('busy')
          }
          entered.resolve()
          await release.promise
          return new TextEncoder().encode('safe')
        },
        new PrefixResolver(() => ['/data/']),
      )
      const controller = new AbortController()
      const pending: Promise<unknown>[] = []
      try {
        const other = interpret(rt, { code: "print(open('/data/other').read())" })
        pending.push(other)
        await entered.promise
        const interrupted = interpret(
          rt,
          {
            code:
              kind === 'abort'
                ? "open('/data/started').read()\nwhile True: pass"
                : 'while True: pass',
          },
          kind === 'abort' ? { signal: controller.signal } : { timeoutSeconds: 0.1 },
        ).catch((error: unknown) => error)
        pending.push(interrupted)
        const next = interpret(rt, { code: 'print(42)' })
        pending.push(next)
        if (kind === 'abort') {
          await started.promise
          controller.abort()
        }
        const result = await interrupted
        if (kind === 'timeout') expect(result).toBeInstanceOf(CommandTimeoutError)
        else expect(result).toMatchObject({ exitCode: 1 })
        const fresh = await next
        expect(fresh.exitCode).toBe(0)
        expect(new TextDecoder().decode(fresh.stdout)).toBe('42\n')
        release.resolve()
        const continued = await other
        expect(continued.exitCode).toBe(0)
        expect(new TextDecoder().decode(continued.stdout)).toBe('safe\n')
      } finally {
        release.resolve()
        controller.abort()
        await Promise.allSettled(pending)
        await rt.close()
      }
    },
  )

  it('truncates nothing when its open stat revokes the run', async () => {
    const rt = new PyodideRuntime()
    const controller = new AbortController()
    const calls: string[] = []
    bindOver(
      rt,
      (op, path, _bytes, _dst, attrs) => {
        if (attrs?.retained !== undefined) return Promise.resolve(attrs.retained)
        calls.push(op)
        if (op === 'stat') {
          controller.abort()
          return Promise.resolve(new FileStat({ name: path, type: FileType.FILE, size: 3 }))
        }
        return Promise.resolve(op === 'read' ? new TextEncoder().encode('abc') : undefined)
      },
      new PrefixResolver(() => ['/data/']),
    )
    try {
      await interpret(rt, { code: "open('/data/f', 'w')" }, { signal: controller.signal }).catch(
        () => undefined,
      )
      expect(calls).not.toContain('truncate')
      expect(calls).not.toContain('write')
    } finally {
      await rt.close()
    }
  })

  it('lands what it wrote before its run was revoked', async () => {
    const rt = new PyodideRuntime()
    const controller = new AbortController()
    const calls: string[] = []
    const missing = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    let made = false
    bindOver(
      rt,
      (op, path, _bytes, _dst, attrs) => {
        if (attrs?.retained !== undefined) return Promise.resolve(attrs.retained)
        calls.push(`${op} ${path}`)
        if (path === '/data/out') {
          if (op === 'create') made = true
          if (op === 'readdir' || (op === 'stat' && !made)) return missing()
          if (op === 'stat')
            return Promise.resolve(new FileStat({ name: 'out', type: FileType.FILE, size: 0 }))
          return Promise.resolve(undefined)
        }
        if (op === 'stat')
          return Promise.resolve(new FileStat({ name: path, type: FileType.FILE, size: 3 }))
        if (op !== 'read') return Promise.resolve(undefined)
        controller.abort()
        return Promise.resolve(new TextEncoder().encode('abc'))
      },
      new PrefixResolver(() => ['/data/']),
    )
    try {
      await interpret(
        rt,
        {
          code: [
            'import os',
            "fd = os.open('/data/out', os.O_WRONLY | os.O_CREAT)",
            "os.write(fd, b'kept')",
            "open('/data/f').read()",
            'os.close(fd)',
          ].join('\n'),
        },
        { signal: controller.signal },
      ).catch(() => undefined)
      expect(calls).toContain('pwrite /data/out')
    } finally {
      await rt.close()
    }
  })

  it('starts no child once the flush before it revokes the run', async () => {
    const rt = new PyodideRuntime()
    const controller = new AbortController()
    const calls: string[] = []
    const missing = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    let made = false
    bindOver(
      rt,
      (op, path, _bytes, _dst, attrs) => {
        if (attrs?.retained !== undefined) return Promise.resolve(attrs.retained)
        calls.push(`${op} ${path}`)
        if (op === 'create') made = true
        if (op === 'pwrite') controller.abort()
        if (op === 'readdir' || (op === 'stat' && !made)) return missing()
        if (op === 'stat')
          return Promise.resolve(new FileStat({ name: path, type: FileType.FILE, size: 0 }))
        return Promise.resolve(undefined)
      },
      new PrefixResolver(() => ['/data/']),
    )
    try {
      await interpret(
        rt,
        {
          code: [
            'import os, subprocess',
            "fd = os.open('/data/out', os.O_WRONLY | os.O_CREAT)",
            "os.write(fd, b'kept')",
            "subprocess.run(['/data/tool'])",
          ].join('\n'),
        },
        { signal: controller.signal },
      ).catch(() => undefined)
      expect(calls).toContain('pwrite /data/out')
      expect(calls).not.toContain('stat /data/tool')
    } finally {
      await rt.close()
    }
  })
})

describe('Python guest module', { timeout: 120_000 }, () => {
  it('preserves output bytes across calls with buffers above the signed wasm32 boundary', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    const output = `hello world — 世界 🌍\n${'x'.repeat(2048)}\n`
    const error = 'stderr — café 🌍\n'
    const code = `import sys; sys.stdout.write(${JSON.stringify(output)}); sys.stderr.write(${JSON.stringify(error)}); sys.stdout.buffer.write(bytes([0, 255, 128])); None`
    const expected = new Uint8Array([...new TextEncoder().encode(output), 0, 255, 128])
    const results: Uint8Array[] = []
    try {
      pyodide.runPython(`
pressure = [bytearray(700 * 1024 * 1024) for _ in range(3)]
small = [str(i).encode() for i in range(100000)]
`)
      for (let call = 0; call < 3; call++) {
        const run = guest.run(
          {
            code,
            argv: [],
            cwd: '',
            flags: {},
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(run[2]).toBe(0)
        expect(run[0]).toEqual(expected)
        expect(run[1]).toEqual(new TextEncoder().encode(error))
        results.push(run[0])
        pyodide.runPython('pressure.append(bytearray(64 * 1024 * 1024))')
      }
      for (const stdout of results) expect(stdout).toEqual(expected)
    } finally {
      pyodide.runPython('del pressure, small')
      guest.close()
    }
  })

  it('executes main guards with fresh globals on every run', async () => {
    const guest = new PyodideExecution(await loadPyodideRuntime())
    try {
      for (const prog of ['submission.py', '-c', '-']) {
        const result = guest.run(
          {
            code: "assert 'previous_run' not in globals()\nprevious_run = True\nif __name__ == '__main__':\n    print('submission result')\n    raise SystemExit(7)",
            argv: [prog],
            cwd: '/',
            flags: {},
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(new TextDecoder().decode(result[0])).toBe('submission result\n')
        expect(new TextDecoder().decode(result[1])).toBe('')
        expect(result[2]).toBe(7)
      }
    } finally {
      guest.close()
    }
  })

  // As CPython's BufferedReader: an empty read asks nothing of the pipe,
  // and readinto fills any writable buffer by its bytes.
  it('reads its input as a BufferedReader does', async () => {
    const guest = new PyodideExecution(await loadPyodideRuntime())
    const log: string[] = []
    let input: Uint8Array | null = new TextEncoder().encode('abcdefgh')
    try {
      const result = guest.run(
        {
          code: [
            'import array, sys',
            "print('a', flush=True)",
            'empty = sys.stdin.buffer.read1(0)',
            "print('b', flush=True)",
            "a = array.array('I', [0, 0])",
            'print(empty, sys.stdin.buffer.readinto(a), a.tobytes())',
          ].join('\n'),
          argv: ['-c'],
          cwd: '/',
          flags: {},
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
          piped: true,
        },
        () => undefined,
        () => undefined,
        {
          read: () => {
            log.push('read')
            const data = input ?? new Uint8Array()
            input = null
            return data
          },
          write: (fd, bytes) => {
            if (fd === 1) log.push(new TextDecoder().decode(bytes))
            return true
          },
        },
      )
      expect(result[2]).toBe(0)
      expect(log).toEqual(['a\n', 'b\n', 'read', "b'' 8 b'abcdefgh'\n"])
    } finally {
      guest.close()
    }
  })

  // Under -u each write goes out as it is made, as CPython's does, so a
  // print os._exit follows is kept.
  it('writes through under -u, as CPython does', async () => {
    const guest = new PyodideExecution(await loadPyodideRuntime())
    const out: string[] = []
    try {
      const result = guest.run(
        {
          code: "import os\nprint('kept')\nos._exit(0)",
          argv: ['-c'],
          cwd: '/',
          flags: { u: true },
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
        },
        () => undefined,
        () => undefined,
        {
          read: () => new Uint8Array(),
          write: (fd, bytes) => {
            if (fd === 1) out.push(new TextDecoder().decode(bytes))
            return true
          },
        },
      )
      expect(result[2]).toBe(0)
      expect(out.join('')).toBe('kept\n')
    } finally {
      guest.close()
    }
  })

  // CPython reports a stdout flush that fails as it exits and makes the
  // exit 120, whatever the program's own; the WASI guest answers the same.
  it('reports a stdout its reader left as it exits, as CPython does', async () => {
    const guest = new PyodideExecution(await loadPyodideRuntime())
    const errors: number[] = []
    try {
      const result = guest.run(
        {
          code: 'import sys\nprint(1)\nsys.exit(3)',
          argv: ['-c'],
          cwd: '/',
          flags: {},
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
        },
        () => undefined,
        () => undefined,
        {
          read: () => new Uint8Array(),
          write: (fd, bytes) => {
            if (fd === 1) return false
            errors.push(...bytes)
            return true
          },
        },
      )
      expect(result[2]).toBe(120)
      expect(new TextDecoder().decode(new Uint8Array(errors))).toMatch(
        /^Exception ignored (while|on) flushing sys\.stdout:\nBrokenPipeError: \[Errno \d+\] Broken pipe\n$/,
      )
    } finally {
      guest.close()
    }
  })

  it('registers an isolated main module for imports and pickling across exits', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    pyodide.runPython("import sys; saved_main = sys.modules['__main__']")
    try {
      for (const [mutation, ending, exitCode] of [
        ["sys.modules['__main__'] = None", '', 0],
        ["del sys.modules['__main__']", 'raise SystemExit(7)', 7],
        ['', "raise ValueError('expected failure')", 1],
      ] as const) {
        const result = guest.run(
          {
            code: `import __main__, pickle, sys
assert __main__.__dict__ is globals()
assert not hasattr(__main__, 'run_only')
class Record:
    value = 42
def identity(value):
    return value
assert pickle.loads(pickle.dumps(Record())).__class__ is Record
assert pickle.loads(pickle.dumps(identity)) is identity
__main__.run_only = 'guest value'
assert run_only == 'guest value'
print('main identity works')
${mutation}
${ending}`,
            argv: ['submission.py'],
            cwd: '/',
            flags: {},
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(new TextDecoder().decode(result[0])).toBe('main identity works\n')
        expect(result[2]).toBe(exitCode)
        expect(new TextDecoder().decode(result[1])).toEqual(
          exitCode === 1 ? expect.stringContaining('ValueError: expected failure') : '',
        )
        expect(pyodide.runPython("sys.modules['__main__'] is saved_main")).toBe(true)
        expect(pyodide.runPython("hasattr(saved_main, 'run_only')")).toBe(false)
      }
    } finally {
      guest.close()
    }
  })

  it('restores absent and null host main-module entries', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    pyodide.runPython("import sys; saved_main = sys.modules['__main__']")
    try {
      for (const missing of [false, true]) {
        pyodide.runPython(
          missing ? "sys.modules.pop('__main__', None)" : "sys.modules['__main__'] = None",
        )
        const result = guest.run(
          {
            code: 'import __main__; assert __main__.__dict__ is globals()',
            argv: ['-c'],
            cwd: '/',
            flags: {},
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(new TextDecoder().decode(result[1])).toBe('')
        expect(result[2]).toBe(0)
        expect(pyodide.runPython("'__main__' not in sys.modules")).toBe(missing)
        if (!missing) expect(pyodide.runPython("sys.modules['__main__'] is None")).toBe(true)
      }
    } finally {
      pyodide.runPython("sys.modules['__main__'] = saved_main")
      guest.close()
    }
  })

  it('restores process globals after closing output and reporting SystemExit', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    pyodide.runPython(`
import os, sys, warnings
def process_state():
    return (dict(os.environ), list(sys.path), list(sys.argv), os.getcwd(),
            sys.dont_write_bytecode, dict(sys._xoptions), list(warnings.filters),
            sys.stdin, sys.stdout, sys.stderr, sys.flags)
saved_state = process_state()
`)
    try {
      const result = guest.run(
        {
          code: "import os, sys; os.environ['CHANGED'] = '1'; sys.path.append('/changed'); os.chdir('/tmp'); print('saved'); sys.stdout.close(); sys.stderr.close(); sys.exit('original exit')",
          argv: ['probe'],
          cwd: '/',
          flags: { B: true, O: 2, P: true, X: ['probe=1'], W: ['ignore'] },
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
        },
        () => undefined,
        () => undefined,
      )
      expect(result[2]).toBe(1)
      expect(new TextDecoder().decode(result[0])).toBe('saved\n')
      expect(new TextDecoder().decode(result[1])).toBe('original exit\n')
      expect(pyodide.runPython('process_state() == saved_state')).toBe(true)
    } finally {
      guest.close()
    }
  })

  it('reports implemented flags as a read-only tuple and preserves native fields', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    const native = pyodide.runPython(`
import json, sys, types
saved_flags = sys.flags
flag_fields = [name for name, field in vars(type(sys.flags)).items()
               if isinstance(field, types.MemberDescriptorType)]
json.dumps({name: getattr(sys.flags, name) for name in flag_fields})
`) as string
    try {
      for (const optimize of [0, 1, 2]) {
        const result = guest.run(
          {
            code: `import json, sys
expected = json.loads(${JSON.stringify(native)})
expected.update(optimize=${String(optimize)}, dont_write_bytecode=1, safe_path=True)
def check(condition):
    if not condition:
        raise AssertionError('flag view mismatch')
check({name: getattr(sys.flags, name) for name in expected} == expected)
check(isinstance(sys.flags, tuple))
check(tuple(sys.flags) == tuple(expected.values())[:sys.flags.n_sequence_fields])
check(set(expected).issubset(dir(sys.flags)))
check('safe_path=True' in repr(sys.flags))
saved_limit = sys.get_int_max_str_digits()
try:
    sys.set_int_max_str_digits(640)
    check(sys.flags.int_max_str_digits == sys.get_int_max_str_digits())
finally:
    sys.set_int_max_str_digits(saved_limit)
for name in ('safe_path', 'optimize', 'dont_write_bytecode'):
    try:
        setattr(sys.flags, name, 0)
    except AttributeError:
        pass
    else:
        raise AssertionError('flag is writable: ' + name)
    try:
        delattr(sys.flags, name)
    except AttributeError:
        pass
    else:
        raise AssertionError('flag is deletable: ' + name)
print(sys.flags.optimize, __debug__, sys.flags.safe_path, '' in sys.path)
`,
            argv: ['-c'],
            cwd: '/',
            flags: { B: true, O: optimize, P: true },
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(new TextDecoder().decode(result[1])).toBe('')
        expect(result[2]).toBe(0)
        expect(new TextDecoder().decode(result[0])).toBe(
          `${String(optimize)} ${optimize === 0 ? 'True' : 'False'} True False\n`,
        )
        expect(pyodide.runPython('sys.flags is saved_flags')).toBe(true)
      }
    } finally {
      guest.close()
    }
  })

  it('compiles the modules a program imports at its -O level', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    pyodide.runPython(`
import importlib._bootstrap_external, os
os.makedirs('/tmp/optimize_probe', exist_ok=True)
with open('/tmp/optimize_probe/optimize_helper.py', 'w') as f:
    f.write('debug = __debug__\\nassert False, "helper assert ran"\\n')
saved_source_to_code = importlib._bootstrap_external.SourceLoader.source_to_code
`)
    try {
      for (const [optimize, stdout, exitCode] of [
        [1, 'False\n', 0],
        [2, 'False\n', 0],
        [0, '', 1],
      ] as const) {
        const result = guest.run(
          {
            code: `import sys
sys.path.insert(0, '/tmp/optimize_probe')
sys.modules.pop('optimize_helper', None)
import optimize_helper
print(optimize_helper.debug)`,
            argv: ['-c'],
            cwd: '/',
            flags: { O: optimize },
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(new TextDecoder().decode(result[0])).toBe(stdout)
        expect(result[2]).toBe(exitCode)
        if (exitCode !== 0) {
          expect(new TextDecoder().decode(result[1])).toContain('helper assert ran')
        }
        expect(
          pyodide.runPython(
            'importlib._bootstrap_external.SourceLoader.source_to_code is saved_source_to_code',
          ),
        ).toBe(true)
      }
    } finally {
      guest.close()
    }
  })

  it('restores interpreter state after guest replacements, exceptions and syntax errors', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    pyodide.runPython(`
import sys, warnings
saved_flags = sys.flags
saved_path, saved_options, saved_filters = sys.path, sys._xoptions, warnings.filters
saved_values = (list(sys.path), dict(sys._xoptions), list(warnings.filters))
`)
    try {
      for (const [code, exitCode] of [
        ['', 0],
        ['raise SystemExit(7)', 7],
        ["raise ValueError('failed')", 1],
        ['if', 1],
      ] as const) {
        const result = guest.run(
          {
            code: `import sys, warnings
sys.flags = None
sys.path = []
sys._xoptions = {}
warnings.filters = []
${code}`,
            argv: ['-c'],
            cwd: '/',
            flags: { P: true, O: 2, B: true, W: ['ignore'], X: ['probe=1'] },
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
        expect(result[2]).toBe(exitCode)
        expect(
          pyodide.runPython(`
sys.flags is saved_flags and sys.path is saved_path and \
sys._xoptions is saved_options and warnings.filters is saved_filters and \
(sys.path, sys._xoptions, warnings.filters) == saved_values
`),
        ).toBe(true)
      }
    } finally {
      guest.close()
    }
  })

  it('preserves closed and detached output in a run and restores streams', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    const decode = (data: Uint8Array) => new TextDecoder().decode(data)
    pyodide.runPython('import sys; saved_streams = (sys.stdin, sys.stdout, sys.stderr)')
    try {
      const run = (code: string) =>
        guest.run(
          {
            code,
            argv: [],
            cwd: '',
            flags: {},
            script_cli: false,
            filename: null,
            script: false,
            env: {},
            stdin: null,
          },
          () => undefined,
          () => undefined,
        )
      for (const operation of [
        'sys.stdout.close(); sys.stderr.close()',
        'sys.stdout.buffer.close(); sys.stderr.buffer.close()',
        'sys.stdout.detach().close(); sys.stderr.detach().close()',
        'sys.stdout = None; sys.stderr = None',
        "sys.stdout.reconfigure(write_through=False, line_buffering=False); sys.stdout.write('buffered')",
      ]) {
        const [stdout, stderr, exitCode] = run(
          `import sys; print('out'); sys.stderr.write('err'); ${operation}`,
        )
        expect(exitCode).toBe(0)
        expect(decode(stdout)).toBe(`out\n${operation.includes('reconfigure') ? 'buffered' : ''}`)
        expect(decode(stderr)).toBe('err')
        expect(pyodide.runPython('saved_streams == (sys.stdin, sys.stdout, sys.stderr)')).toBe(true)
        expect(decode(run("print('next')")[0])).toBe('next\n')
      }
      for (const code of [
        "import sys; sys.stderr.close(); raise ValueError('original failure')",
        "import sys; sys.stderr.detach(); raise ValueError('original failure')",
      ]) {
        const [, stderr, exitCode] = run(code)
        expect(exitCode).toBe(1)
        expect(decode(stderr)).toContain('ValueError: original failure')
      }
      const binary = run('import sys; sys.stdout.buffer.write(bytes([0, 255])); sys.stdout.close()')
      expect([...binary[0]]).toEqual([0, 255])
      expect(binary[2]).toBe(0)
      const closed = run("import sys; sys.stdout.close(); print('refused')")
      expect(closed[2]).toBe(1)
      expect(decode(closed[1])).toContain('ValueError: I/O operation on closed file')
    } finally {
      guest.close()
    }
  })

  it('releases converted arguments and keeps helper globals outside guest programs', async () => {
    const pyodide = await loadPyodideRuntime()
    const toPy = pyodide.toPy
    const converted: { toJs: () => unknown }[] = []
    pyodide.toPy = (value) => {
      const proxy = toPy(value)
      if (proxy !== null && typeof proxy === 'object' && 'toJs' in proxy)
        converted.push(proxy as { toJs: () => unknown })
      return proxy
    }
    const guest = new PyodideExecution(pyodide)
    try {
      const probe = guest.run(
        {
          code: "print('run' in globals() or '_saved_env' in globals())",
          argv: [],
          cwd: '',
          flags: {},
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
        },
        () => undefined,
        () => undefined,
      )
      expect(new TextDecoder().decode(probe[0])).toBe('False\n')
      // The first proxy owns the module; each later proxy is a call argument.
      for (const proxy of converted.slice(1)) expect(() => proxy.toJs()).toThrow(/destroyed/i)
      expect(pyodide.runPython("'_saved_env' in globals() or '_eval_result' in globals()")).toBe(
        false,
      )
    } finally {
      guest.close()
    }
    for (const proxy of converted) expect(() => proxy.toJs()).toThrow(/destroyed/i)
  })

  it('distinguishes absent and empty stdin for script CLIs without changing ordinary globals', async () => {
    const rt = new PyodideRuntime()
    try {
      for (const [stdin, expected] of [
        [null, 'None'],
        [new Uint8Array(), "b''"],
      ] as const) {
        const result = await interpret(rt, {
          code: 'print(argv); print(stdin)',
          prog: 'pager',
          args: ['one'],
          scriptCli: true,
          stdin,
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe(`['pager', 'one']\n${expected}\n`)
      }
      const ordinary = await interpret(rt, {
        code: "print('argv' in globals(), 'stdin' in globals())",
        prog: '/work/script.py',
      })
      expect(new TextDecoder().decode(ordinary.stdout)).toBe('False False\n')
    } finally {
      await rt.close()
    }
  })
})

describe('Pyodide command cwd', { timeout: 120_000 }, () => {
  it('keeps executing with a cwd on an unsupported root mount', async () => {
    const rt = new PyodideRuntime()
    try {
      bindOver(
        rt,
        () => Promise.reject(new Error('root mount must not be read')),
        new PrefixResolver(() => ['/']),
      )
      const before = await defaultCwd(rt)
      const result = await interpret(
        rt,
        { code: 'import os; print(1); print(os.getcwd())' },
        { cwd: PathSpec.fromStrPath('/unservable/nested') },
      )
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toBe(`1\n${before}\n`)
      const root = await interpret(
        rt,
        { code: 'import os; print(os.getcwd())' },
        { cwd: PathSpec.fromStrPath('/') },
      )
      expect(root.exitCode).toBe(0)
      expect(new TextDecoder().decode(root.stdout)).toBe('/\n')
    } finally {
      await rt.close()
    }
  })

  it('still rejects a missing cwd on a supported child of a root mount', async () => {
    const rt = new PyodideRuntime()
    bindOver(
      rt,
      () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      new PrefixResolver(() => ['/', '/data/']),
    )
    try {
      const result = await interpret(
        rt,
        { code: "print('must not run')" },
        { cwd: PathSpec.fromStrPath('/data/missing') },
      )
      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stdout)).toBe('')
    } finally {
      await rt.close()
    }
  })

  it('restores trusted cwd functions when user code replaces or deletes them', async () => {
    const rt = new PyodideRuntime({
      config: {
        bootstrapCode:
          "import os; os.makedirs('/tmp/a', exist_ok=True); os.makedirs('/tmp/b', exist_ok=True)",
      },
    })
    try {
      const before = await defaultCwd(rt)
      for (const code of [
        'import os; os.chdir = lambda _: None',
        "import os; del os.chdir; raise ValueError('expected')",
        "import os; os.getcwd = lambda: '/missing-cwd'",
        "import os; del os.getcwd; raise ValueError('expected')",
      ]) {
        await interpret(rt, { code }, { cwd: PathSpec.fromStrPath('/tmp/a') })
        expect(await defaultCwd(rt)).toBe(before)
        const next = await interpret(
          rt,
          { code: 'from pathlib import Path; print(Path.cwd())' },
          { cwd: PathSpec.fromStrPath('/tmp/b') },
        )
        expect(next.exitCode).toBe(0)
        expect(new TextDecoder().decode(next.stdout)).toBe('/tmp/b\n')
      }
    } finally {
      await rt.close()
    }
  })

  it('isolates queued runs and restores cwd after success and errors', async () => {
    const rt = new PyodideRuntime({
      config: {
        bootstrapCode:
          "import os; os.makedirs('/tmp/a', exist_ok=True); os.makedirs('/tmp/b', exist_ok=True)",
      },
    })
    try {
      const before = await defaultCwd(rt)
      const results = await Promise.all(
        ['/tmp/a', '/tmp/b'].map((cwd) =>
          interpret(
            rt,
            {
              code: "import os; print(os.getcwd()); os.chdir('/tmp'); raise ValueError('expected')",
            },
            { env: { PWD: '/wrong' }, cwd: PathSpec.fromStrPath(cwd) },
          ),
        ),
      )
      expect(results.map((r) => new TextDecoder().decode(r.stdout))).toEqual([
        '/tmp/a\n',
        '/tmp/b\n',
      ])
      expect(results.map((r) => r.exitCode)).toEqual([1, 1])
      expect(await defaultCwd(rt)).toBe(before)
      const missing = await interpret(
        rt,
        { code: "print('must not run')" },
        { cwd: PathSpec.fromStrPath('/missing-cwd') },
      )
      expect(missing.exitCode).toBe(1)
      expect(new TextDecoder().decode(missing.stdout)).toBe('')
      const fresh = await interpret(rt, { code: 'import os; print(os.getcwd())' }, { cwd: NO_CWD })
      expect(new TextDecoder().decode(fresh.stdout)).toBe(`${before}\n`)
    } finally {
      await rt.close()
    }
  })
})

it.each([false, true])(
  'passes only the command environment (worker: %s)',
  async (worker) => {
    const key = 'MIRAGE_ENV_LEAK_PROBE'
    vi.stubEnv(key, 'host-marker')
    const execute = vi.spyOn(PyodideWorkerClient.prototype, 'execute')
    const rt = new PyodideRuntime()
    if (worker)
      bindOver(
        rt,
        () => Promise.reject(new Error('unexpected I/O')),
        new PrefixResolver(() => ['/data/']),
      )
    try {
      for (const [env, expected] of [
        [{}, '<unset>'],
        [{ [key]: 'guest-marker' }, 'guest-marker'],
        [{}, '<unset>'],
      ] as const) {
        const result = await interpret(
          rt,
          {
            code: `import os; print(os.environ.get('${key}', '<unset>')); os.environ['${key}'] = 'changed'`,
          },
          { env },
        )
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe(`${expected}\n`)
        expect(process.env[key]).toBe('host-marker')
      }
      if (worker) expect(execute).toHaveBeenCalled()
      else expect(execute).not.toHaveBeenCalled()
    } finally {
      await rt.close()
      execute.mockRestore()
      vi.unstubAllEnvs()
    }
  },
  120_000,
)

describe('Pyodide run cwd', { timeout: 120_000 }, () => {
  it("a bound run takes the caller's cwd, not the session's", async () => {
    const rt = new PyodideRuntime({ config: { autoLoadFromImports: false } })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [rt, 'workspace'],
      },
    )
    const dec = new TextDecoder()
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      const code = 'import os; print(os.getcwd())'
      const run = await rt.execute([], [], context({ flags: { c: code } }))
      expect(dec.decode(run.stdout)).toBe('/\n')
      const explicit = await rt.execute(
        [],
        [],
        context({ flags: { c: code }, cwd: PathSpec.fromStrPath('/data/sub') }),
      )
      expect(dec.decode(explicit.stdout)).toBe('/data/sub\n')
    } finally {
      await ws.close()
    }
  })
})

const tracebackCases = JSON.parse(
  readFileSync(
    new URL('../../../../../../../integ/fixtures/runtime/python_errors.json', import.meta.url),
    'utf8',
  ),
) as { code: string; stderr: string }[]

it.each(tracebackCases)(
  'prints only user traceback frames: $code',
  async ({ code, stderr }) => {
    const guest = new PyodideExecution(await loadPyodideRuntime())
    try {
      const result = guest.run(
        {
          code,
          argv: ['-c'],
          cwd: '',
          flags: {},
          script_cli: false,
          filename: null,
          script: false,
          env: {},
          stdin: null,
        },
        () => undefined,
        () => undefined,
      )
      expect(result[2]).toBe(1)
      expect(new TextDecoder().decode(result[1])).toBe(stderr)
    } finally {
      guest.close()
    }
  },
  120_000,
)
