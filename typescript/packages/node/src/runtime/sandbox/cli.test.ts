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
import { ProcessInput } from '@struktoai/mirage-core/process/stdio'
import { PipeClosed } from '@struktoai/mirage-core/io/errors'

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

// A child that starts a sleep in a session of its own, so killing the
// child's group leaves it running with the output pipes it inherited.
const ESCAPE = [
  "const { spawn } = require('node:child_process')",
  "const c = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' })",
  "require('node:fs').writeFileSync(process.argv[1], String(c.pid))",
  'setTimeout(() => undefined, 30000)',
].join('\n')

async function escapedPid(pidFile: string): Promise<number> {
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return Number(readFileSync(pidFile, 'utf8'))
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

  it('keeps input-close listeners bounded while consuming a long byte source', async () => {
    const children = new Set<ChildProcess>()
    let chunks = 0
    async function* input() {
      for (let i = 0; i < 5000; i++) {
        const child = [...children][0]
        if (child?.stdin === null || child?.stdin === undefined)
          throw new Error('missing child input')
        expect(child.stdin.listenerCount('close')).toBeLessThanOrEqual(2)
        chunks++
        yield await Promise.resolve(new Uint8Array(1024))
      }
    }
    const result = await runCli('wc', null, ['-c'], input(), { children })
    expect(result.code).toBe(0)
    expect(Number(DEC.decode(result.stdout).trim())).toBe(5000 * 1024)
    expect(chunks).toBe(5000)
  })

  it('finishes an exited command with an open, idle managed stdin', async () => {
    const input = new ProcessInput()
    const result = await runCli('sh', null, ['-c', 'printf done'], input.stream())
    expect(result.code).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('done')
    await expect(input.write(new TextEncoder().encode('late'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it('finishes an exited command while a plain input pull is still waiting', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* input(): AsyncGenerator<Uint8Array> {
      await held
      yield new Uint8Array()
    }
    try {
      const result = await runCli('sh', null, ['-c', 'printf done'], input())
      expect([result.code, DEC.decode(result.stdout)]).toEqual([0, 'done'])
    } finally {
      release()
    }
  })

  it('aborts a command while its managed input pull is waiting', async () => {
    const input = new ProcessInput()
    const controller = new AbortController()
    const run = runCli('sh', null, ['-c', 'exec sleep 30'], input.stream(), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await expect(input.write(new TextEncoder().encode('late'))).rejects.toBeInstanceOf(PipeClosed)
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

  it('does not wait on a descendant that left the group when aborted', async () => {
    const controller = new AbortController()
    const pidFile = join(mkdtempSync(join(tmpdir(), 'mirage-cli-')), 'pid')
    const run = runCli(process.execPath, null, ['-e', ESCAPE, pidFile], null, {
      signal: controller.signal,
    })
    const escaped = await escapedPid(pidFile)
    try {
      const started = Date.now()
      controller.abort()
      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      process.kill(escaped, 'SIGKILL')
    }
  })

  it('closeChildren does not wait on a descendant that left the group', async () => {
    const children = new Set<ChildProcess>()
    const pidFile = join(mkdtempSync(join(tmpdir(), 'mirage-cli-')), 'pid')
    const run = runCli(process.execPath, null, ['-e', ESCAPE, pidFile], null, { children })
    const escaped = await escapedPid(pidFile)
    try {
      const started = Date.now()
      await closeChildren(children)
      expect((await run).code).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      process.kill(escaped, 'SIGKILL')
    }
  })

  it('closeChildren skips a child that closed while its input is still closing', async () => {
    const children = new Set<ChildProcess>()
    let closing = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      closing = resolve
    })
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const input: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: async () => {
        closing()
        await held
        return { done: true, value: undefined }
      },
    }
    const run = runCli('sh', null, ['-c', 'exit 0'], input, { children })
    await entered
    await closeChildren(children)
    release()
    expect((await run).code).toBe(0)
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
