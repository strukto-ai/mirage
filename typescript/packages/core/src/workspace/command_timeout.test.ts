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
import { CommandSpec } from '../commands/spec/types.ts'
import { CLIHandler } from '../commands/cli/types.ts'
import type { Context } from '../commands/config.ts'

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMAND_LIMITS } from '../policy/builtin/output_cap.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import type { Program, RunResult } from '../runtime/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { Limit, MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'
import { CLI } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'

class SignalProbeRuntime extends LanguageRuntime {
  readonly language = 'python'
  readonly name = 'probe'
  aborted = false

  constructor() {
    super({ captures: ['python3', 'python'] })
  }

  interpret(_engine: unknown, _program: Program, ctx: Context): Promise<RunResult> {
    return new Promise((resolve) => {
      ctx.signal?.addEventListener('abort', () => {
        this.aborted = true
        resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 1 })
      })
    })
  }
}

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

afterEach(() => {
  delete DEFAULT_COMMAND_LIMITS.sleep
})

function buildWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, shellParser: parser })
}

describe('command timeout', () => {
  it('quick command under default does not fire', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 1 })
    const ws = buildWs()
    try {
      const r = await ws.shell('sleep 0.05')
      expect(r.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('default limit fires with attributed stderr and exit 124', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 0.05 })
    const ws = buildWs()
    try {
      const r = await ws.shell('sleep 2')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('sleep: timed out after 0.05s')
    } finally {
      await ws.close()
    }
  })

  it('pipeline: first stage to trip wins', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 0.05 })
    const ws = buildWs()
    try {
      const r = await ws.shell('sleep 2 | echo done')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('sleep: timed out')
    } finally {
      await ws.close()
    }
  })

  it('timeout of zero disables the guard', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 0 })
    const ws = buildWs()
    try {
      const r = await ws.shell('sleep 0.05')
      expect(r.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('a streamed builtin keeps its deadline after it returns', async () => {
    DEFAULT_COMMAND_LIMITS.xargs = new Limit({ timeoutSeconds: 0.05 })
    const ws = buildWs()
    try {
      const r = await ws.shell("printf '2\\n' | xargs sleep")
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('xargs: timed out after 0.05s')
    } finally {
      delete DEFAULT_COMMAND_LIMITS.xargs
      await ws.close()
    }
  })
})

// python3 is guarded like any other command: the same limit surface,
// the same enforcement point, exit 124. ~2s of interpreter work against a
// 0.25s budget; the deadline SIGKILLs monty's worker, so close() never
// waits on it.
const SLOW_SCRIPT = "printf 'n = 0\\nfor i in range(100000000):\\n    n = n + 1\\n' > /data/slow.py"

describe('python3 command timeout', () => {
  afterEach(() => {
    delete DEFAULT_COMMAND_LIMITS.python3
  })

  function buildPyWs(limits?: Record<string, Record<string, Limit>>): Workspace {
    const ram = new RAMVFS()
    return new Workspace(
      { '/data': [ram, MountMode.EXEC, limits?.['/data'] ?? {}] },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: ['monty', 'quickjs', 'workspace'],
      },
    )
  }

  it('default limit fires like any other command', async () => {
    DEFAULT_COMMAND_LIMITS.python3 = new Limit({ timeoutSeconds: 0.25 })
    const ws = buildPyWs()
    try {
      await ws.shell(SLOW_SCRIPT)
      const r = await ws.shell('python3 /data/slow.py')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('mount-level limit fires like any other command', async () => {
    const ws = buildPyWs({
      '/data': { python3: new Limit({ timeoutSeconds: 0.25 }) },
    })
    try {
      await ws.shell(SLOW_SCRIPT)
      const r = await ws.shell('cd /data && python3 /data/slow.py')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('mount-level limit follows the script path, not cwd', async () => {
    const ws = buildPyWs({
      '/data': { python3: new Limit({ timeoutSeconds: 0.25 }) },
    })
    try {
      await ws.shell(SLOW_SCRIPT)
      const r = await ws.shell('python3 /data/slow.py')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('the timeout aborts the run signal so a runtime can reclaim what it spawned', async () => {
    const probe = new SignalProbeRuntime()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [probe, 'workspace'],
        commandLimits: { python3: new Limit({ timeoutSeconds: 0.1 }) },
      },
    )
    try {
      const r = await ws.shell('cd /data && python3 -c "hang"')
      expect(r.exitCode).toBe(124)
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a busy pyodide loop trips the limit instead of wedging the event loop', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: ['pyodide', 'workspace'],
        commandLimits: { python3: new Limit({ timeoutSeconds: 0.5 }) },
      },
    )
    try {
      const started = Date.now()
      const r = await ws.shell('cd /data && python3 -c "while True: pass"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('timed out')
      expect(Date.now() - started).toBeLessThan(60_000)
    } finally {
      await ws.close()
    }
  }, 120_000)

  it('a busy monty loop trips the limit and the worker is reclaimed', async () => {
    const ws = buildPyWs({
      '/data': { python3: new Limit({ timeoutSeconds: 0.25 }) },
    })
    try {
      const r = await ws.shell('cd /data && python3 -c "while True: pass"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      // close() must not hang on the killed worker's session.
      await ws.close()
    }
  }, 60_000)

  it('a busy JS loop trips the limit instead of wedging the event loop', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: ['quickjs', 'workspace'],
        commandLimits: { node: new Limit({ timeoutSeconds: 0.3 }) },
      },
    )
    try {
      const started = Date.now()
      const r = await ws.shell('cd /data && node -e "while (true) {}"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('timed out')
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      await ws.close()
    }
  }, 60_000)
})

describe('background job kill', () => {
  it('kill %1 aborts the runtime run of a background job', async () => {
    const probe = new SignalProbeRuntime()
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [probe, 'workspace'] },
    )
    try {
      await ws.shell('python3 -c "hang" &')
      await ws.shell('kill %1')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a killed subshell stops its EXIT action', async () => {
    const ws = buildWs()
    const reached: string[] = []
    for (const name of ['started', 'reached'])
      ws.registerCli(
        name,
        new CLI({
          spec: new CommandSpec({ name }),
          handlers: {
            '': new CLIHandler({
              fn: () => {
                reached.push(name)
                return Promise.resolve([null, new IOResult()])
              },
            }),
          },
        }),
      )
    try {
      const running = ws.shell('(trap "started; sleep 0.3; reached" EXIT; true); echo after')
      const subshell = () =>
        ws.jobTable.processes.live().find((p) => p.info.command.startsWith('(trap'))
      const deadline = Date.now() + 3000
      while (subshell() === undefined) {
        if (Date.now() > deadline) throw new Error('the subshell never started')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      subshell()?.terminate()
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(reached).toEqual(['started'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('kill %1 interrupts a sleeping job promptly', async () => {
    const ws = buildWs()
    try {
      const started = Date.now()
      await ws.shell('sleep 60 &')
      await ws.shell('kill %1')
      await ws.shell('wait %1')
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      await ws.close()
    }
  }, 60_000)
})

// CPU work must offer cancellation points even when every read is immediately ready.
describe('large in-memory commands', () => {
  it.each([
    'wc /big',
    'grep -c line /big',
    'cat /big | wc',
    'cat -s /blank',
    'head -n -2500000 /blank',
    'uniq /big',
  ])('honors a caller abort during %s', async (command) => {
    const ram = new RAMVFS()
    ram.store.files.set('/big', new TextEncoder().encode('line\n'.repeat(500_000)))
    ram.store.files.set('/blank', new TextEncoder().encode('\n'.repeat(2_500_000)))
    const ws = new Workspace({ '/': ram }, { shellParser: parser })
    const abort = new AbortController()
    const timer = setTimeout(() => {
      abort.abort()
    }, 5)
    try {
      await expect(ws.shell(command, { signal: abort.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
    } finally {
      clearTimeout(timer)
      await ws.close()
    }
  })

  // A walk the index answers awaits only microtasks; the op guard and the
  // tree walk hand the abort a turn.
  it.each([
    'find /wide -name nothing',
    'ls -lR /wide',
    'du -a /wide',
    'tree /wide',
    'grep -r nothing /wide',
    'rg nothing /wide',
    'cp -r /wide /copy',
    'chmod -R 700 /wide',
    'tar -cf /wide.tar /wide',
    'zip -qr /wide.zip /wide',
  ])('honors a caller abort during the walk of %s', async (command) => {
    const ram = new RAMVFS({ walkLimit: -1 })
    ram.store.dirs.add('/wide')
    for (let d = 0; d < 100; d++) {
      ram.store.dirs.add(`/wide/d${String(d)}`)
      for (let f = 0; f < 200; f++)
        ram.store.files.set(`/wide/d${String(d)}/f${String(f)}`, new Uint8Array([120, 10]))
    }
    const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, shellParser: parser })
    const abort = new AbortController()
    const timer = setTimeout(() => {
      abort.abort()
    }, 5)
    try {
      await expect(ws.shell(command, { signal: abort.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
    } finally {
      clearTimeout(timer)
      await ws.close()
    }
  })

  it('lets a caller abort tr after output starts', async () => {
    const ram = new RAMVFS()
    ram.store.files.set('/big', new TextEncoder().encode('line\n'.repeat(500_000)))
    const ws = new Workspace({ '/': ram }, { shellParser: parser })
    const abort = new AbortController()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    let timer: ReturnType<typeof setTimeout> | undefined
    let fired = false
    try {
      const execution = await ws.shell('tr a b < /big', {
        signal: abort.signal,
        stream: true,
      })
      try {
        const first = await execution.events.next()
        if (first.done === true) throw new Error('tr finished before producing output')
        expect(first.value.stream).toBe('stdout')
        expect(first.value.data.byteLength).toBeGreaterThan(0)
        timer = setTimeout(() => {
          fired = true
          abort.abort()
        }, 0)
        // Elapsed work must let the real abort timer run, regardless of CPU speed.
        now = 1_000_000
        async function consume(): Promise<void> {
          for await (const event of execution.events) expect(event.stream).toBe('stdout')
        }
        await expect(consume()).rejects.toMatchObject({ name: 'AbortError' })
        expect(fired).toBe(true)
      } finally {
        await execution.close()
      }
    } finally {
      clearTimeout(timer)
      clock.mockRestore()
      await ws.close()
    }
  })
})
