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
import { captureBinding, WorkspaceBinding } from '../../binding.ts'
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
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Pyodide execution lifetime', { timeout: 120_000 }, () => {
  it.each(['inline', 'worker', 'fallback'] as const)(
    'isolates commands, one-shot eval, and named consoles (%s)',
    async (mode) => {
      const rt = new PyodideRuntime({ config: { autoLoadFromImports: false } })
      const fallback =
        mode === 'fallback' ? vi.spyOn(PyodideWorkerClient, 'create').mockResolvedValue(null) : null
      if (mode !== 'inline') {
        rt.bind(
          new WorkspaceBinding(
            () => Promise.reject(new Error('unexpected filesystem operation')),
            new PrefixResolver(() => []),
          ),
        )
      }
      const mutate =
        "import builtins, json, sys, types; builtins.mirage_token = 42; json.mirage_token = 42; sys.modules['mirage_token'] = types.ModuleType('mirage_token')"
      const inspect =
        "import builtins, json, sys; print(hasattr(builtins, 'mirage_token'), hasattr(json, 'mirage_token'), 'mirage_token' in sys.modules)"
      const clean = 'False False False\n'
      const dec = new TextDecoder()
      try {
        const first = await rt.run({ code: mutate, args: [], env: {}, stdin: null })
        expect(first.exitCode).toBe(0)
        expect(dec.decode((await rt.eval(inspect)).stdout)).toBe(clean)
        await rt.eval(mutate)
        const next = await rt.run({ code: inspect, args: [], env: {}, stdin: null })
        expect(next.exitCode).toBe(0)
        expect(dec.decode(next.stdout)).toBe(clean)
        expect((await rt.eval(mutate, { session: 'one' })).exitCode).toBe(0)
        expect(dec.decode((await rt.eval(inspect, { session: 'two' })).stdout)).toBe(clean)
        expect(dec.decode((await rt.eval(inspect)).stdout)).toBe(clean)
        const command = await rt.run({ code: inspect, args: [], env: {}, stdin: null })
        expect(dec.decode(command.stdout)).toBe(clean)
        expect(dec.decode((await rt.eval(inspect, { session: 'one' })).stdout)).toBe(
          'True True True\n',
        )
      } finally {
        await rt.close()
        fallback?.mockRestore()
      }
    },
  )
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
      rt.bind(
        new WorkspaceBinding(
          async (op, path) => {
            if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 5 })
            const read = reads.get(path.slice('/data/'.length))
            if (op !== 'read' || read === undefined) throw new Error(`unexpected ${op}: ${path}`)
            read.entered.resolve()
            await read.release.promise
            return new TextEncoder().encode(getCurrentSession()?.sessionId ?? 'missing')
          },
          new PrefixResolver(() => ['/data/']),
        ),
      )
      const run = (name: string) =>
        runWithSession(new SessionState({ sessionId: name }), () =>
          rt.run({ code: `print(open('/data/${name}').read())`, args: [], env: {}, stdin: null }),
        )
      try {
        const first =
          maxConcurrency === 1
            ? runWithSession(new SessionState({ sessionId: 'one' }), () =>
                rt.eval("value = open('/data/one').read(); print(value)", { session: 'first' }),
              )
            : run('one')
        const second = runWithSession(new SessionState({ sessionId: 'two' }), () =>
          rt.eval("open('/data/two').read(); raise ValueError('expected failure')"),
        ).catch((error: unknown) => error)
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
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('expected failure')
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
      const release = gate()
      const rt = new PyodideRuntime({ config: { maxConcurrency: 2 } })
      rt.bind(
        new WorkspaceBinding(
          async (op, path) => {
            if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 4 })
            if (op !== 'read') throw new Error(`unexpected ${op}: ${path}`)
            entered.resolve()
            await release.promise
            return new TextEncoder().encode('safe')
          },
          new PrefixResolver(() => ['/data/']),
        ),
      )
      const controller = new AbortController()
      const pending: Promise<unknown>[] = []
      try {
        const other = rt.run({
          code: "print(open('/data/other').read())",
          args: [],
          env: {},
          stdin: null,
        })
        pending.push(other)
        await entered.promise
        const interrupted = rt
          .run({
            code: 'while True: pass',
            args: [],
            env: {},
            stdin: null,
            ...(kind === 'abort' ? { signal: controller.signal } : { timeoutSeconds: 0.1 }),
          })
          .catch((error: unknown) => error)
        pending.push(interrupted)
        const next = rt.run({ code: 'print(42)', args: [], env: {}, stdin: null })
        pending.push(next)
        controller.abort()
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

  it('serializes each console without occupying another call slot', async () => {
    const rt = new PyodideRuntime({ config: { maxConcurrency: 2 } })
    const reads = new Map(
      ['first', 'second', 'other'].map(
        (name) => [name, { entered: gate(), release: gate() }] as const,
      ),
    )
    const create = vi.spyOn(PyodideWorkerClient, 'create')
    const pending: Promise<unknown>[] = []
    rt.bind(
      new WorkspaceBinding(
        async (op, path) => {
          if (op === 'stat') return new FileStat({ name: path, type: FileType.FILE, size: 0 })
          const read = reads.get(path.slice('/data/'.length))
          if (op !== 'read' || read === undefined) throw new Error(`unexpected ${op}: ${path}`)
          read.entered.resolve()
          await read.release.promise
          return new Uint8Array()
        },
        new PrefixResolver(() => ['/data/']),
      ),
    )
    try {
      const first = rt.eval("token = 41; value = open('/data/first').read(); print(token)", {
        session: 'one',
      })
      const second = rt.eval("token += 1; value = open('/data/second').read(); print(token)", {
        session: 'one',
      })
      const other = rt.eval("value = open('/data/other').read(); print('token' in globals())", {
        session: 'two',
      })
      pending.push(first, second, other)
      await Promise.all([reads.get('first')?.entered.promise, reads.get('other')?.entered.promise])
      expect(create).toHaveBeenCalledTimes(2)
      reads.get('first')?.release.resolve()
      await reads.get('second')?.entered.promise
      expect(create).toHaveBeenCalledTimes(2)
      reads.get('second')?.release.resolve()
      reads.get('other')?.release.resolve()
      const results = await Promise.all([first, second, other])
      expect(results.map((result) => new TextDecoder().decode(result.stdout))).toEqual([
        '41\n',
        '42\n',
        'False\n',
      ])
      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0])
    } finally {
      for (const read of reads.values()) read.release.resolve()
      await Promise.allSettled(pending)
      await rt.close()
      create.mockRestore()
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
        const evaluated = guest.evaluate(code, {})
        const repl = guest.repl(`exec(${JSON.stringify(code)})`, 'large-heap', {})
        expect(run[2]).toBe(0)
        expect(evaluated[3]).toBe(true)
        expect(repl[2]).toBe(0)
        for (const [stdout, stderr] of [
          [run[0], run[1]],
          [evaluated[1], evaluated[2]],
          [repl[0], repl[1]],
        ] as const) {
          expect(stdout).toEqual(expected)
          expect(stderr).toEqual(new TextEncoder().encode(error))
          results.push(stdout)
        }
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

  it('preserves closed and detached output in run, eval and REPL and restores streams', async () => {
    const pyodide = await loadPyodideRuntime()
    const guest = new PyodideExecution(pyodide)
    const decode = (data: Uint8Array) => new TextDecoder().decode(data)
    pyodide.runPython('import sys; saved_streams = (sys.stdin, sys.stdout, sys.stderr)')
    try {
      for (const mode of ['run', 'eval', 'repl']) {
        for (const operation of [
          'sys.stdout.close(); sys.stderr.close()',
          'sys.stdout.buffer.close(); sys.stderr.buffer.close()',
          'sys.stdout.detach().close(); sys.stderr.detach().close()',
          'sys.stdout = None; sys.stderr = None',
          "sys.stdout.reconfigure(write_through=False, line_buffering=False); sys.stdout.write('buffered')",
        ]) {
          const code = `import sys; print('out'); sys.stderr.write('err'); ${operation}`
          let stdout: Uint8Array
          let stderr: Uint8Array
          if (mode === 'run') {
            const result = guest.run(
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
            expect(result[2]).toBe(0)
            ;[stdout, stderr] = result
          } else if (mode === 'eval') {
            const result = guest.evaluate(`${code}; None`, {})
            expect(result[3]).toBe(true)
            ;[, stdout, stderr] = result
          } else {
            // An exec statement avoids REPL displayhook output for write()'s return value.
            const result = guest.repl(`exec(${JSON.stringify(code)})`, 'streams', {})
            expect(result[2]).toBe(0)
            ;[stdout, stderr] = result
          }
          expect(decode(stdout)).toBe(`out\n${operation.includes('reconfigure') ? 'buffered' : ''}`)
          expect(decode(stderr)).toBe('err')
          expect(pyodide.runPython('saved_streams == (sys.stdin, sys.stdout, sys.stderr)')).toBe(
            true,
          )
          expect(decode(guest.evaluate("print('next')", {})[1])).toBe('next\n')
        }
      }
      for (const code of [
        "import sys; sys.stderr.close(); raise ValueError('original failure')",
        "import sys; sys.stderr.detach(); raise ValueError('original failure')",
      ]) {
        const result = guest.evaluate(code, {})
        expect(result[3]).toBe(false)
        expect(decode(result[2])).toContain('ValueError: original failure')
      }
      const binary = guest.evaluate(
        'import sys; sys.stdout.buffer.write(bytes([0, 255])); sys.stdout.close()',
        {},
      )
      expect([...binary[1]]).toEqual([0, 255])
      expect(binary[3]).toBe(true)
      const closed = guest.evaluate("import sys; sys.stdout.close(); print('refused')", {})
      expect(closed[3]).toBe(false)
      expect(decode(closed[2])).toContain('ValueError: I/O operation on closed file')
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
      expect(guest.evaluate("'run' in globals() or '_saved_env' in globals()", {})[0]).toBe('false')
      // The first proxy owns the module; each later proxy is a call argument.
      for (const proxy of converted.slice(1)) expect(() => proxy.toJs()).toThrow(/destroyed/i)
      expect(pyodide.runPython("'_saved_env' in globals() or '_eval_result' in globals()")).toBe(
        false,
      )
      expect(guest.repl('answer = 42', 'one', {})[2]).toBe(0)
      expect(new TextDecoder().decode(guest.repl('answer', 'one', {})[0])).toBe('42\n')
      expect(guest.repl('answer', 'two', {})[2]).toBe(1)
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
        const result = await rt.run({
          code: 'print(argv); print(stdin)',
          prog: 'pager',
          args: ['one'],
          scriptCli: true,
          env: {},
          stdin,
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe(`['pager', 'one']\n${expected}\n`)
      }
      const ordinary = await rt.run({
        code: "print('argv' in globals(), 'stdin' in globals())",
        prog: '/work/script.py',
        args: [],
        env: {},
        stdin: null,
      })
      expect(new TextDecoder().decode(ordinary.stdout)).toBe('False False\n')
    } finally {
      await rt.close()
    }
  })
})

describe('Pyodide command cwd', { timeout: 120_000 }, () => {
  it.each([false, true])(
    'keeps executing with a cwd on an unsupported root mount (eager: %s)',
    async (eager) => {
      const rt = new PyodideRuntime()
      const fallback = eager
        ? vi.spyOn(PyodideWorkerClient, 'create').mockResolvedValue(null)
        : null
      try {
        rt.bind(
          new WorkspaceBinding(
            () => Promise.reject(new Error('root mount must not be read')),
            new PrefixResolver(() => ['/']),
            (binding) =>
              captureBinding(binding, { cwd: PathSpec.fromStrPath('/unservable/nested') }),
          ),
        )
        const before = await rt.eval('import os; os.getcwd()')
        if (typeof before.value !== 'string') throw new Error('cwd must be a string')
        const result = await rt.run({
          code: 'import os; print(1); print(os.getcwd())',
          args: [],
          env: {},
          stdin: null,
          cwd: PathSpec.fromStrPath('/unservable/nested'),
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe(`1\n${before.value}\n`)
        const root = await rt.run({
          code: 'import os; print(os.getcwd())',
          args: [],
          env: {},
          stdin: null,
          cwd: PathSpec.fromStrPath('/'),
        })
        expect(root.exitCode).toBe(0)
        expect(new TextDecoder().decode(root.stdout)).toBe('/\n')
      } finally {
        await rt.close()
        fallback?.mockRestore()
      }
    },
  )

  it('still rejects a missing cwd on a supported child of a root mount', async () => {
    const rt = new PyodideRuntime()
    rt.bind(
      new WorkspaceBinding(
        () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
        new PrefixResolver(() => ['/', '/data/']),
      ),
    )
    try {
      const result = await rt.run({
        code: "print('must not run')",
        args: [],
        env: {},
        stdin: null,
        cwd: PathSpec.fromStrPath('/data/missing'),
      })
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
      const before = await rt.eval('import os; os.getcwd()')
      for (const code of [
        'import os; os.chdir = lambda _: None',
        "import os; del os.chdir; raise ValueError('expected')",
        "import os; os.getcwd = lambda: '/missing-cwd'",
        "import os; del os.getcwd; raise ValueError('expected')",
      ]) {
        await rt.run({ code, args: [], env: {}, stdin: null, cwd: PathSpec.fromStrPath('/tmp/a') })
        expect((await rt.eval('import os; os.getcwd()')).value).toBe(before.value)
        const next = await rt.run({
          code: 'from pathlib import Path; print(Path.cwd())',
          args: [],
          env: {},
          stdin: null,
          cwd: PathSpec.fromStrPath('/tmp/b'),
        })
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
      const before = await rt.eval('import os; os.getcwd()')
      if (typeof before.value !== 'string') throw new Error('cwd must be a string')
      const results = await Promise.all(
        ['/tmp/a', '/tmp/b'].map((cwd) =>
          rt.run({
            code: "import os; print(os.getcwd()); os.chdir('/tmp'); raise ValueError('expected')",
            args: [],
            env: { PWD: '/wrong' },
            stdin: null,
            cwd: PathSpec.fromStrPath(cwd),
          }),
        ),
      )
      expect(results.map((r) => new TextDecoder().decode(r.stdout))).toEqual([
        '/tmp/a\n',
        '/tmp/b\n',
      ])
      expect(results.map((r) => r.exitCode)).toEqual([1, 1])
      expect((await rt.eval('import os; os.getcwd()')).value).toBe(before.value)
      const missing = await rt.run({
        code: "print('must not run')",
        args: [],
        env: {},
        stdin: null,
        cwd: PathSpec.fromStrPath('/missing-cwd'),
      })
      expect(missing.exitCode).toBe(1)
      expect(new TextDecoder().decode(missing.stdout)).toBe('')
      const fresh = await rt.run({
        code: 'import os; print(os.getcwd())',
        args: [],
        env: {},
        stdin: null,
      })
      expect(new TextDecoder().decode(fresh.stdout)).toBe(`${before.value}\n`)
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
      rt.bind(
        new WorkspaceBinding(
          () => Promise.reject(new Error('unexpected I/O')),
          new PrefixResolver(() => ['/data/']),
        ),
      )
    try {
      for (const [env, expected] of [
        [{}, '<unset>'],
        [{ [key]: 'guest-marker' }, 'guest-marker'],
        [{}, '<unset>'],
      ] as const) {
        const result = await rt.run({
          code: `import os; print(os.environ.get('${key}', '<unset>')); os.environ['${key}'] = 'changed'`,
          args: [],
          env,
          stdin: null,
        })
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

describe('Pyodide evaluation cwd', { timeout: 120_000 }, () => {
  it.each([false, true])(
    'recovers a console after its cwd disappears (eager: %s)',
    async (eager) => {
      const rt = new PyodideRuntime({ config: { autoLoadFromImports: false } })
      const fallback = eager
        ? vi.spyOn(PyodideWorkerClient, 'create').mockResolvedValue(null)
        : null
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [rt, 'workspace'] },
      )
      const dec = new TextDecoder()
      try {
        expect((await ws.shell('cd /data')).exitCode).toBe(0)
        for (const mutation of ['rmdir /data/sub', 'mv /data/sub /data/moved']) {
          expect((await ws.shell('mkdir /data/sub')).exitCode).toBe(0)
          const session = mutation
          const first = await rt.eval("import os; token = 42; os.chdir('sub')", { session })
          expect(first.exitCode).toBe(0)
          expect((await ws.shell(mutation)).exitCode).toBe(0)
          const missing = await rt.eval("print('must not run')", { session })
          expect(missing.exitCode).toBe(1)
          expect(dec.decode(missing.stdout)).toBe('')
          expect(dec.decode(missing.stderr ?? new Uint8Array())).toContain('FileNotFoundError')
          const recovered = await rt.eval("print(token, os.getcwd()); os.chdir('/data')", {
            session,
          })
          expect(recovered.exitCode).toBe(0)
          expect(dec.decode(recovered.stdout)).toBe('42 /\n')
          const next = await rt.eval('print(os.getcwd())', { session })
          expect(next.exitCode).toBe(0)
          expect(dec.decode(next.stdout)).toBe('/data\n')
          expect((await rt.eval('import os; os.getcwd()')).value).toBe('/data')
        }
      } finally {
        await ws.close()
        fallback?.mockRestore()
      }
    },
  )

  it.each([false, true])('inherits cwd and isolates consoles (eager: %s)', async (eager) => {
    const rt = new PyodideRuntime({ config: { autoLoadFromImports: false } })
    const fallback = eager ? vi.spyOn(PyodideWorkerClient, 'create').mockResolvedValue(null) : null
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: [rt, 'workspace'],
      },
    )
    const dec = new TextDecoder()
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/data')
      const run = await rt.run({
        code: 'import os; print(os.getcwd())',
        args: [],
        env: {},
        stdin: null,
      })
      expect(dec.decode(run.stdout)).toBe('/data\n')
      const explicit = await rt.run({
        code: 'import os; print(os.getcwd())',
        args: [],
        env: {},
        stdin: null,
        cwd: PathSpec.fromStrPath('/data/sub'),
      })
      expect(dec.decode(explicit.stdout)).toBe('/data/sub\n')
      const first = await rt.eval(
        "import os; os.chdir('sub'); print(os.getcwd()); raise ValueError('expected')",
        { session: 'a' },
      )
      expect(first.exitCode).toBe(1)
      expect(dec.decode(first.stdout)).toBe('/data/sub\n')
      expect(
        dec.decode((await rt.eval('import os; print(os.getcwd())', { session: 'b' })).stdout),
      ).toBe('/data\n')
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/data')
      await expect(
        rt.eval("import os; os.chdir('sub'); del os.chdir; raise ValueError('expected')"),
      ).rejects.toThrow('expected')
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/data')
      expect((await ws.shell('cd /')).exitCode).toBe(0)
      expect(
        dec.decode((await rt.eval("print(open('item').read(), end='')", { session: 'a' })).stdout),
      ).toBe('child\n')
      expect(
        dec.decode(
          (
            await rt.eval(
              "import os; os.getcwd = lambda: '/wrong'; os.chdir = lambda _: None; print('ok')",
              { session: 'a' },
            )
          ).stdout,
        ),
      ).toBe('ok\n')
      expect(
        dec.decode((await rt.eval('import os; print(os.getcwd())', { session: 'a' })).stdout),
      ).toBe('/data/sub\n')
      expect(
        dec.decode((await rt.eval('import os; print(os.getcwd())', { session: 'b' })).stdout),
      ).toBe('/data\n')
      expect(
        dec.decode((await rt.eval('import os; print(os.getcwd())', { session: 'c' })).stdout),
      ).toBe('/\n')
      expect((await rt.eval('import os; os.getcwd()')).value).toBe('/')
    } finally {
      await ws.close()
      fallback?.mockRestore()
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
