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

import { describe, expect, it } from 'vitest'
import type { Context } from '../../../../commands/config.ts'
import { ChildProcess } from '../../../../process/child.ts'
import { ProcessInput, ProcessOutput } from '../../../../process/stdio.ts'
import { ProcessTable } from '../../../../process/table.ts'
import { PathSpec } from '../../../../types.ts'
import type { RuntimeFiles } from '../../../files.ts'
import { GuestProcessTable } from './process.ts'

// A spawned command that ends once a stop with `ending` reaches it, as a
// program that ignores gentler signals does.
function spawned(ending: number): ChildProcess {
  const abort = new AbortController()
  const run = async (): Promise<number> => {
    if (!abort.signal.aborted)
      await new Promise((resolve) => {
        abort.signal.addEventListener('abort', resolve, { once: true })
      })
    while (process.signal !== ending) await new Promise((resolve) => setTimeout(resolve, 5))
    throw new DOMException('aborted', 'AbortError')
  }
  const process = new ProcessTable().start({
    sessionId: 'a',
    command: 'sleep 30',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      abort.abort()
    },
    run,
  })
  return new ChildProcess(process, new ProcessInput(), new ProcessOutput(), (signal) =>
    process.terminate(signal),
  )
}

// The guest's table over a workspace that spawns `child` and finds every
// program on PATH.
function guestTable(child: ChildProcess): GuestProcessTable {
  const ctx = {
    processes: { checkSpawn: () => undefined, spawn: () => child },
  } as unknown as Context
  const files = {
    stat: (path: string) => Promise.resolve({ isDir: path === '/', mode: 0o755 }),
  } as unknown as RuntimeFiles
  return new GuestProcessTable(ctx, files)
}

async function call(
  table: GuestProcessTable,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await table.call(JSON.stringify(request))) as Record<string, unknown>
}

async function spawn(table: GuestProcessTable): Promise<number> {
  const { pid } = await call(table, {
    op: 'spawn',
    argv: ['sleep', '30'],
    cwd: '/',
    env: { PATH: '/usr/bin' },
    stdin: -1,
    stdout: -1,
    stderr: -1,
  })
  return pid as number
}

describe('GuestProcessTable', () => {
  // `Popen.terminate()` and `kill()` stop the command with the signal they
  // send, so a program under it gets TERM first.
  it.each([
    [15, 143],
    [9, 137],
  ])('a guest signal %i stops its command with it', async (signal, code) => {
    const child = spawned(signal)
    const table = guestTable(child)
    const pid = await spawn(table)
    expect(await call(table, { op: 'kill', pid, signal })).toMatchObject({ returncode: null })
    expect((await child.wait()).exitCode).toBe(code)
  })

  // A `kill()` after `terminate()` stops what ignores TERM at once.
  it('a guest KILL after its TERM takes over', async () => {
    const child = spawned(9)
    const table = guestTable(child)
    const pid = await spawn(table)
    await call(table, { op: 'kill', pid, signal: 15 })
    await call(table, { op: 'kill', pid, signal: 9 })
    expect((await child.wait()).exitCode).toBe(137)
  })
})
