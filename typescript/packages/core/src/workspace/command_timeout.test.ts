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

import { describe, expect, it, vi } from 'vitest'
import { LanguageRuntime } from '../runtime/language.ts'
import type { RuntimeEntry } from '../runtime/base.ts'
import { ScriptSource, type Program, type RunResult } from '../runtime/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Limit, MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'
import { programs } from './lookup/lookup.ts'
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

const DEC = new TextDecoder()

function buildWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

// An interpreter runs under the line's one deadline like any other command:
// past it the run's signal aborts, a busy guest is interrupted, and the line
// answers 124.
describe('interpreters at the line deadline', () => {
  function lineWs(runtimes: RuntimeEntry[], seconds: number): Workspace {
    return new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes,
        commandLimits: { line: new Limit({ timeoutSeconds: seconds }) },
      },
    )
  }

  it('aborts the run signal so a runtime can reclaim what it spawned', async () => {
    const probe = new SignalProbeRuntime()
    const ws = lineWs([probe, 'workspace'], 0.1)
    try {
      const r = await ws.shell('cd /data && python3 -c "hang"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.1s')
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a busy pyodide loop trips the deadline instead of wedging the event loop', async () => {
    const ws = lineWs(['pyodide', 'workspace'], 0.5)
    try {
      const started = Date.now()
      const r = await ws.shell('cd /data && python3 -c "while True: pass"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.5s')
      expect(Date.now() - started).toBeLessThan(60_000)
    } finally {
      await ws.close()
    }
  }, 120_000)

  it('a busy monty loop trips the deadline and the worker is reclaimed', async () => {
    const ws = lineWs(['monty', 'workspace'], 0.25)
    try {
      const r = await ws.shell('cd /data && python3 -c "while True: pass"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.25s')
    } finally {
      // close() must not hang on the killed worker's session.
      await ws.close()
    }
  }, 60_000)

  // QuickJS holds the event loop, so only its interrupt hook, which fires the
  // deadline (atDeadline, fireDue), can end the line.
  it('a busy JS loop trips the deadline instead of wedging the event loop', async () => {
    const ws = lineWs(['quickjs', 'workspace'], 0.3)
    try {
      const started = Date.now()
      const r = await ws.shell('cd /data && node -e "while (true) {}"')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.3s')
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a busy JS script CLI trips the deadline through the leaf signal', async () => {
    const ws = lineWs(['quickjs', 'workspace'], 0.3)
    ws.registerCli(
      'spin',
      new CLI({
        spec: new CommandSpec({ name: 'spin' }),
        script: new ScriptSource('while (true) {}', 'js'),
        runtime: 'quickjs',
      }),
    )
    try {
      const r = await ws.shell('spin')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.3s')
      expect((await ws.shell('echo next')).exitCode).toBe(0)
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
      { mode: MountMode.EXEC, runtimes: [probe, 'workspace'] },
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

const UNCAPPED = { '*': new Limit({ walkLimit: -1 }) }

function wideRam(): RAMVFS {
  const ram = new RAMVFS()
  ram.store.files.set('/big', new TextEncoder().encode('line\n'.repeat(20_000)))
  ram.store.dirs.add('/wide')
  for (let d = 0; d < 100; d++) {
    ram.store.dirs.add(`/wide/d${String(d)}`)
    for (let f = 0; f < 200; f++)
      ram.store.files.set(`/wide/d${String(d)}/f${String(f)}`, new Uint8Array([120, 10]))
  }
  return ram
}

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
    const ws = new Workspace({ '/': ram })
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
    const ws = new Workspace(
      { '/': [wideRam(), MountMode.WRITE, UNCAPPED] },
      { mode: MountMode.WRITE },
    )
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
    const ws = new Workspace({ '/': ram })
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

// Every program the shell resolves, given a big file and a wide directory,
// ends on its own or within a second of the caller's abort. Each runs in a
// subshell, so a `cd`, `set` or `exec` leaves the next one's shell as it was.
it('every program settles soon after an abort', async () => {
  const ws = new Workspace({ '/': [wideRam(), MountMode.READ, UNCAPPED] }, {})
  const internals = ws as unknown as {
    callSession(): Parameters<typeof programs>[0]
    registry: Parameters<typeof programs>[1]
  }
  const late: string[] = []
  try {
    for (const name of programs(internals.callSession(), internals.registry)) {
      for (const operand of ['/big', '/wide']) {
        const abort = new AbortController()
        let fired = -1
        const timer = setTimeout(() => {
          fired = performance.now()
          abort.abort()
        }, 5)
        let stuck: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            ws.shell(`( ${name} ${operand} )`, { signal: abort.signal }).catch(() => null),
            new Promise((resolve) => {
              stuck = setTimeout(() => {
                late.push(`${name} ${operand}: still running after 5s`)
                resolve(null)
              }, 5000)
            }),
          ])
        } finally {
          clearTimeout(timer)
          clearTimeout(stuck)
        }
        if (fired >= 0 && performance.now() - fired > 1000)
          late.push(`${name} ${operand}: ${((performance.now() - fired) / 1000).toFixed(2)}s late`)
      }
    }
  } finally {
    await ws.close()
  }
  expect(late).toEqual([])
}, 300_000)
