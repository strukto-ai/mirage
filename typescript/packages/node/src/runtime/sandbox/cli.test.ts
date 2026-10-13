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
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeChildren, runCli } from './cli.ts'

const DEC = new TextDecoder()

// Whether a process has exited: gone, or a zombie its new parent has not
// reaped yet. Polled, since a kill lands asynchronously.
async function ended(pid: number): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).stdout.trim()
    if (state === '' || state.startsWith('Z')) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

describe('runCli', () => {
  it('returns both streams and the status', async () => {
    const r = await runCli(
      'sh',
      'no sh',
      ['-c', 'cat; echo e >&2; exit 3'],
      new TextEncoder().encode('in'),
    )
    expect([DEC.decode(r.stdout), DEC.decode(r.stderr), r.code]).toEqual(['in', 'e\n', 3])
  })

  it('rejects a missing CLI with its hint', async () => {
    await expect(runCli('mirage-no-such-cli', 'install it', [], null)).rejects.toThrow('install it')
  })

  it('kills the child when the call is aborted', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const run = runCli('sh', 'no sh', ['-c', 'exec sleep 30'], null, { signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 50)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills what the child started, which holds its pipes open', async () => {
    const controller = new AbortController()
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-'))
    const pidFile = join(dir, 'pid')
    const run = runCli('sh', null, ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], null, {
      signal: controller.signal,
    })
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const started = Date.now()
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await ended(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  })

  it('closeChildren kills every running tree and waits for it', async () => {
    const children = new Set<ChildProcess>()
    const run = runCli('sh', null, ['-c', 'sleep 30 & wait'], null, { children })
    expect(children.size).toBe(1)
    const started = Date.now()
    await closeChildren(children)
    expect((await run).code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(children.size).toBe(0)
  })
})
