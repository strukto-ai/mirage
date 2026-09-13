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
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_COMMAND_LIMITS } from '../policy/builtin/output_cap.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import type { RunArgs, RunResult } from '../runtime/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { Limit, MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

class SignalProbeRuntime extends LanguageRuntime {
  readonly language = 'python'
  readonly name = 'probe'
  aborted = false

  constructor() {
    super({ captures: ['python3', 'python'] })
  }

  run(args: RunArgs): Promise<RunResult> {
    return new Promise((resolve) => {
      args.signal?.addEventListener('abort', () => {
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
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

describe('command timeout', () => {
  it('quick command under default does not fire', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 1 })
    const ws = buildWs()
    try {
      const r = await ws.execute('sleep 0.05')
      expect(r.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('default limit fires with attributed stderr and exit 124', async () => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 0.05 })
    const ws = buildWs()
    try {
      const r = await ws.execute('sleep 2')
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
      const r = await ws.execute('sleep 2 | echo done')
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
      const r = await ws.execute('sleep 0.05')
      expect(r.exitCode).toBe(0)
    } finally {
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
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    return new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        runtimes: ['monty', 'quickjs', 'vfs'],
        ...(limits !== undefined ? { commandLimits: limits } : {}),
      },
    )
  }

  it('default limit fires like any other command', async () => {
    DEFAULT_COMMAND_LIMITS.python3 = new Limit({ timeoutSeconds: 0.25 })
    const ws = buildPyWs()
    try {
      await ws.execute(SLOW_SCRIPT)
      const r = await ws.execute('python3 /data/slow.py')
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
      await ws.execute(SLOW_SCRIPT)
      const r = await ws.execute('cd /data && python3 /data/slow.py')
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
      await ws.execute(SLOW_SCRIPT)
      const r = await ws.execute('python3 /data/slow.py')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('the timeout aborts the run signal so a runtime can reclaim what it spawned', async () => {
    const probe = new SignalProbeRuntime()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        runtimes: [probe, 'vfs'],
        commandLimits: {
          '/data': { python3: new Limit({ timeoutSeconds: 0.1 }) },
        },
      },
    )
    try {
      const r = await ws.execute('cd /data && python3 -c "hang"')
      expect(r.exitCode).toBe(124)
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a busy pyodide loop trips the limit instead of wedging the event loop', async () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        runtimes: ['pyodide', 'vfs'],
        commandLimits: {
          '/data': { python3: new Limit({ timeoutSeconds: 0.5 }) },
        },
      },
    )
    try {
      const started = Date.now()
      const r = await ws.execute('cd /data && python3 -c "while True: pass"')
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
      const r = await ws.execute('cd /data && python3 -c "while True: pass"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('python3: timed out after 0.25s')
    } finally {
      // close() must not hang on the killed worker's session.
      await ws.close()
    }
  }, 60_000)

  it('a busy JS loop trips the limit instead of wedging the event loop', async () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.EXEC,
        ops: registry,
        shellParser: parser,
        runtimes: ['quickjs', 'vfs'],
        commandLimits: {
          '/data': { node: new Limit({ timeoutSeconds: 0.3 }) },
        },
      },
    )
    try {
      const started = Date.now()
      const r = await ws.execute('cd /data && node -e "while (true) {}"')
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
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.EXEC, ops: registry, shellParser: parser, runtimes: [probe, 'vfs'] },
    )
    try {
      await ws.execute('python3 -c "hang" &')
      await ws.execute('kill %1')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('kill %1 interrupts a sleeping job promptly', async () => {
    const ws = buildWs()
    try {
      const started = Date.now()
      await ws.execute('sleep 60 &')
      await ws.execute('kill %1')
      await ws.execute('wait %1')
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      await ws.close()
    }
  }, 60_000)
})

// CPU work must offer cancellation points even when every read is immediately ready.
describe('large in-memory commands', () => {
  it.each(['wc /big', 'grep -c line /big', 'cat /big | wc'])(
    'honors a caller abort during %s',
    async (command) => {
      const ram = new RAMResource()
      ram.store.files.set('/big', new TextEncoder().encode('line\n'.repeat(500_000)))
      const ws = new Workspace({ '/': ram }, { shellParser: parser })
      const abort = new AbortController()
      const timer = setTimeout(() => {
        abort.abort()
      }, 5)
      try {
        await expect(ws.execute(command, { signal: abort.signal })).rejects.toMatchObject({
          name: 'AbortError',
        })
      } finally {
        clearTimeout(timer)
      }
    },
  )
})
