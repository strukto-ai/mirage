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
import type { BridgeDispatchFn } from './mirage_bridge.ts'
import { MontyRuntime } from './runtimes/monty.ts'
import { PyodideRuntime } from './runtimes/pyodide.ts'
import { selectPythonRuntime } from './runtimes/select.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace.ts'

function makeBridge(seed: Record<string, Uint8Array>): {
  dispatch: BridgeDispatchFn
  files: Map<string, Uint8Array>
  writes: [string, Uint8Array][]
} {
  const files = new Map(Object.entries(seed))
  const writes: [string, Uint8Array][] = []
  const dispatch: BridgeDispatchFn = (op, path, bytes) => {
    if (op === 'READ') {
      const data = files.get(path)
      if (data === undefined) return Promise.reject(new Error(`no such file: ${path}`))
      return Promise.resolve(data)
    }
    if (op === 'WRITE') {
      const data = bytes ?? new Uint8Array()
      files.set(path, data)
      writes.push([path, data])
      return Promise.resolve(undefined)
    }
    const prefix = path
    const entries: { path: string; size: number; isDir: boolean }[] = []
    for (const [p, content] of files) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        if (!rest.includes('/')) entries.push({ path: p, size: content.length, isDir: false })
      }
    }
    if (entries.length === 0) return Promise.reject(new Error(`no such dir: ${prefix}`))
    return Promise.resolve(entries)
  }
  return { dispatch, files, writes }
}

function run(
  rt: MontyRuntime,
  code: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return rt.run({ code, args, env, stdin: null })
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('MontyRuntime', () => {
  const runtimes: MontyRuntime[] = []
  const make = (options: ConstructorParameters<typeof MontyRuntime>[0] = {}): MontyRuntime => {
    const rt = new MontyRuntime(options)
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

  it('serves os.getenv from the run env only', async () => {
    const result = await run(make(), "import os\nprint(os.getenv('MY_VAR', 'unset'))", [], {
      MY_VAR: 'v1',
    })
    expect(text(result.stdout)).toBe('v1\n')
  }, 30_000)

  it('reads a virtual file through the bridge via pathlib', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new TextEncoder().encode('virtual') })
    const rt = make({ workspaceBridge: dispatch })
    const result = await run(
      rt,
      "from pathlib import Path\nprint(Path('/s3/a.txt').read_text().upper())",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('VIRTUAL\n')
  }, 30_000)

  it('writes flush back through the bridge', async () => {
    const { dispatch, writes } = makeBridge({ '/s3/seed.txt': new Uint8Array([1]) })
    const rt = make({ workspaceBridge: dispatch })
    const result = await run(rt, "from pathlib import Path\nPath('/s3/out.txt').write_text('data')")
    expect(result.exitCode).toBe(0)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe('/s3/out.txt')
    expect(text(writes[0]?.[1] ?? new Uint8Array())).toBe('data')
  }, 30_000)

  it('iterdir lists a virtual directory', async () => {
    const { dispatch } = makeBridge({
      '/s3/a.txt': new Uint8Array([1]),
      '/s3/b.txt': new Uint8Array([2]),
    })
    const rt = make({ workspaceBridge: dispatch })
    const result = await run(
      rt,
      "from pathlib import Path\nprint(sorted(str(p) for p in Path('/s3').iterdir()))",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe("['/s3/a.txt', '/s3/b.txt']\n")
  }, 30_000)

  it('exists/is_file answer from the bridge', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make({ workspaceBridge: dispatch })
    const result = await run(
      rt,
      "from pathlib import Path\nprint(Path('/s3/a.txt').is_file(), Path('/s3/nope').exists())",
    )
    expect(result.exitCode).toBe(0)
    expect(text(result.stdout)).toBe('True False\n')
  }, 30_000)

  it('host filesystem stays invisible', async () => {
    const result = await run(
      make(),
      "from pathlib import Path\nprint(Path('/etc/passwd').read_text())",
    )
    expect(result.exitCode).toBe(1)
    expect(text(result.stderr)).toContain('Error')
  }, 30_000)

  it('repl keeps state per session id', async () => {
    const rt = make()
    await rt.runRepl({ code: 'x = 40', sessionId: 's1' })
    const result = await rt.runRepl({ code: 'print(x + 2)', sessionId: 's1' })
    expect(result.status).toBe('complete')
    expect(text(result.stdout)).toBe('42\n')
  }, 30_000)

  it('a missing virtual file surfaces as an error without poisoning the runtime', async () => {
    const { dispatch } = makeBridge({ '/s3/a.txt': new Uint8Array([1]) })
    const rt = make({ workspaceBridge: dispatch })
    const bad = await run(rt, "from pathlib import Path\nPath('/s3/missing.txt').read_text()")
    expect(bad.exitCode).toBe(1)
    expect(text(bad.stderr)).toContain('Error')
    const ok = await run(rt, 'print(1 + 1)')
    expect(ok.exitCode).toBe(0)
    expect(text(ok.stdout)).toBe('2\n')
  }, 30_000)

  it('paths outside the live mount view never reach the bridge', async () => {
    const { dispatch } = makeBridge({ '/etc/passwd': new TextEncoder().encode('leak') })
    const rt = make({ workspaceBridge: dispatch, listMounts: () => ['/s3/'] })
    const result = await run(rt, "from pathlib import Path\nprint(Path('/etc/passwd').read_text())")
    expect(result.exitCode).toBe(1)
    expect(text(result.stdout)).not.toContain('leak')
  }, 30_000)

  it('has the monty name', () => {
    expect(make().name).toBe('monty')
  })
})

describe('Workspace with pythonRuntime: monty', () => {
  it('python3 reads a virtualized file end to end', async () => {
    const parser = await getTestParser()
    const data = new RAMResource()
    const ws = new Workspace(
      { '/data': data },
      { mode: MountMode.EXEC, shellParser: parser, pythonRuntime: 'monty' },
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
    await ws.close()
  }, 60_000)
})

describe('monty unavailable', () => {
  it('handlePython maps MontyUnavailableError to exit 127', async () => {
    const { handlePython } = await import('./handle.ts')
    const { MontyUnavailableError } = await import('./runtimes/monty.ts')
    const runtime = {
      name: 'monty',
      run: () => Promise.reject(new MontyUnavailableError('install @pydantic/monty')),
      runRepl: () => Promise.reject(new MontyUnavailableError('install @pydantic/monty')),
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

describe('selectPythonRuntime', () => {
  it('defaults to pyodide', () => {
    expect(selectPythonRuntime(undefined)).toBeInstanceOf(PyodideRuntime)
  })

  it('selects monty', () => {
    expect(selectPythonRuntime('monty')).toBeInstanceOf(MontyRuntime)
  })

  it('rejects unknown names', () => {
    expect(() => selectPythonRuntime('docker')).toThrow(/unknown python runtime/)
  })

  it("hints that 'local' is Python-only", () => {
    expect(() => selectPythonRuntime('local')).toThrow(/Python-only/)
  })
})
