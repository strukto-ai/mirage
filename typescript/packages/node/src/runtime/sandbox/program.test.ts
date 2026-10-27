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

import { describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { closeChildren, hostRun, openProgramPipe, reapHostRun, runProgram } from './program.ts'
import { ProcessTable } from '@struktoai/mirage-core/process/table'
import type { ProcessHandle } from '@struktoai/mirage-core/process/handle'
import { runWithExecution } from '@struktoai/mirage-core/context/session_context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { PIPE_DIAGNOSTIC_BYTES } from '@struktoai/mirage-core/runtime/sandbox/constants'
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

async function* oneThenOpen(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('x')
  await new Promise<void>(() => undefined)
}

async function escapedPid(pidFile: string): Promise<number> {
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return Number(readFileSync(pidFile, 'utf8'))
}

// A runner whose run is `sh -c script`, stopped through its abort.
function shRunner(
  script: string,
  output?: (chunk: Uint8Array) => Promise<void>,
  direct = false,
  stdin: AsyncIterable<Uint8Array> | null = null,
): ProcessHandle {
  const abort = new AbortController()
  return new ProcessTable(runWithExecution).start({
    sessionId: 's',
    command: 'sh',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      abort.abort()
    },
    run: async () =>
      (
        await runProgram('sh', null, ['-c', script], stdin, {
          signal: abort.signal,
          direct,
          ...(output === undefined ? {} : { output }),
        })
      ).exitCode,
  })
}

describe('runProgram', () => {
  // A kill that names TERM reaches the program as TERM, so its handler
  // runs, and the runner's status is bash's 143 for a child TERM ended.
  it('lets the child handle the TERM a kill sent its runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, said] = [join(dir, 'pid'), join(dir, 'said')]
    const runner = shRunner(
      `trap 'echo bye > ${said}; exit 0' TERM; echo $$ > ${pidFile}; ` +
        'while :; do sleep 0.05; done',
    )
    await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    expect((await runner.join()).exitCode).toBe(143)
    expect(readFileSync(said, 'utf8')).toBe('bye\n')
  })

  it('gives the child no handler when a kill sent its runner KILL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, said] = [join(dir, 'pid'), join(dir, 'said')]
    const runner = shRunner(
      `trap 'echo bye > ${said}; exit 0' TERM; echo $$ > ${pidFile}; ` +
        'while :; do sleep 0.05; done',
    )
    const child = await escapedPid(pidFile)
    expect(runner.terminate(9)).toBe(true)
    expect((await runner.join()).exitCode).toBe(137)
    expect(existsSync(said)).toBe(false)
    expect(await ended(child)).toBe(true)
  })

  // A KILL while a program still has the grace an earlier TERM gave it ends
  // that grace: what ignores TERM is killed at once, as a second
  // `kill -KILL` does, not a second later.
  it('ends the grace when a KILL follows the TERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const runner = shRunner(`trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`)
    const child = await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const killed = Date.now()
    expect(runner.terminate(9)).toBe(true)
    expect((await runner.join()).exitCode).toBe(137)
    expect(Date.now() - killed).toBeLessThan(500)
    expect(await ended(child)).toBe(true)
  })

  // A child that is the program itself and exits on its own after a gentler
  // signal leaves its status with the runner; a client's (`docker exec`)
  // says nothing about the program, and a child the signal ended has none.
  it.each([
    [true, "trap 'exit 3' TERM; ", 15, 3],
    [false, "trap 'exit 3' TERM; ", 15, null],
    [true, '', 15, null],
    [true, "trap 'exit 3' TERM; ", 9, null],
  ] as const)(
    'leaves the status of a direct child that handled the signal (direct %s, %j, %d)',
    async (direct, trap, signum, code) => {
      const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
      const pidFile = join(dir, 'pid')
      const runner = shRunner(
        `${trap}echo $$ > ${pidFile}; while :; do sleep 0.05; done`,
        undefined,
        direct,
      )
      await escapedPid(pidFile)
      expect(runner.terminate(signum)).toBe(true)
      expect((await runner.join()).exitCode).toBe(128 + signum)
      expect(runner.programCode).toBe(code)
    },
  )

  // A kill reaches the program once, as bash's does: a handler that counts
  // its signals, or one already exiting, must not see a second.
  it('signals the child once for a kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, count] = [join(dir, 'pid'), join(dir, 'count')]
    const program = [
      'const fs = require("node:fs")',
      `process.on("SIGTERM", () => { fs.appendFileSync("${count}", "x\\n"); setTimeout(() => process.exit(0), 200) })`,
      `fs.writeFileSync("${pidFile}", String(process.pid))`,
      'setInterval(() => undefined, 1000)',
    ].join('\n')
    const runner = shRunner(`exec '${process.execPath}' -e '${program}'`)
    await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    await runner.join()
    expect(readFileSync(count, 'utf8')).toBe('x\n')
  })

  // macOS answers EPERM where Linux answers ESRCH for a group whose members
  // have all exited but are not yet reaped; either way the group is gone,
  // and the stop must not fail on it.
  it('treats a group that answers EPERM as gone', async () => {
    const kill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      try {
        return kill(pid, signal)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }
    })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
      const pidFile = join(dir, 'pid')
      const runner = shRunner(
        `trap 'exit 0' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`,
      )
      await escapedPid(pidFile)
      expect(runner.terminate(15)).toBe(true)
      const info = await runner.join()
      expect([info.exitCode, info.failure]).toEqual([143, null])
    } finally {
      spy.mockRestore()
    }
  })

  // The grace is the group's: a descendant still handling the signal after
  // the program it ran under has exited keeps its second.
  it('lets a descendant keep the grace after its parent exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, said] = [join(dir, 'pid'), join(dir, 'said')]
    const runner = shRunner(
      `sh -c 'trap "sleep 0.3; echo bye > ${said}; exit 0" TERM; ` +
        `while :; do sleep 0.05; done' >/dev/null 2>&1 & echo $$ > ${pidFile}; wait`,
    )
    await escapedPid(pidFile)
    await delay(200)
    expect(runner.terminate(15)).toBe(true)
    await runner.join()
    expect(readFileSync(said, 'utf8')).toBe('bye\n')
  })

  // What ignores the signal, a descendant too, ends with KILL after the
  // grace, though the program it ran under exited at once.
  it('kills a descendant that ignores the signal after its parent exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, kidFile] = [join(dir, 'pid'), join(dir, 'kid')]
    const runner = shRunner(
      `sh -c "trap '' TERM; while :; do sleep 0.05; done" >/dev/null 2>&1 & ` +
        `echo $! > ${kidFile}; echo $$ > ${pidFile}; wait`,
    )
    await escapedPid(pidFile)
    const kid = await escapedPid(kidFile)
    await delay(200)
    expect(runner.terminate(15)).toBe(true)
    await runner.join()
    expect(await ended(kid)).toBe(true)
  })

  // A handler that writes more than a pipe holds is not blocked on it, even
  // with a consumer that no longer reads: the output is dropped.
  it('lets a handler writing its output finish in the grace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, said] = [join(dir, 'pid'), join(dir, 'said')]
    const runner = shRunner(
      `trap 'head -c 300000 /dev/zero; head -c 300000 /dev/zero >&2; ` +
        `echo bye > ${said}; exit 0' TERM; echo $$ > ${pidFile}; ` +
        'while :; do sleep 0.05; done',
      () => new Promise<void>(() => undefined),
    )
    await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    await runner.join()
    expect(readFileSync(said, 'utf8')).toBe('bye\n')
  })

  // The input ends before the grace starts, as a closed pipe would: a
  // handler that reads its input to the end gets there instead of waiting
  // on a source that is still open until KILL.
  it('ends the input of a child whose handler reads it to the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const [pidFile, said] = [join(dir, 'pid'), join(dir, 'said')]
    const program = [
      'const fs = require("node:fs")',
      'process.on("SIGTERM", () => { let n = 0; process.stdin.on("data", (c) => { n += c.length }); ' +
        `process.stdin.on("end", () => { fs.writeFileSync("${said}", String(n)); process.exit(0) }) })`,
      `fs.writeFileSync("${pidFile}", String(process.pid))`,
      'setInterval(() => undefined, 1000)',
    ].join('\n')
    const runner = shRunner(
      `exec '${process.execPath}' -e '${program}'`,
      undefined,
      true,
      oneThenOpen(),
    )
    await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    await runner.join()
    expect(readFileSync(said, 'utf8')).toBe('1')
  })

  // A program that ignores the signal still ends: KILL follows the grace.
  it('kills a child that ignores the signal once the grace has passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const runner = shRunner(`trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`)
    const child = await escapedPid(pidFile)
    expect(runner.terminate(15)).toBe(true)
    expect((await runner.join()).exitCode).toBe(143)
    expect(await ended(child)).toBe(true)
  })

  it('returns both streams and the status', async () => {
    const r = await runProgram(
      'sh',
      'no sh',
      ['-c', 'cat; echo e >&2; exit 3'],
      new TextEncoder().encode('in'),
    )
    expect([DEC.decode(r.stdout), DEC.decode(r.stderr ?? undefined), r.exitCode]).toEqual([
      'in',
      'e\n',
      3,
    ])
  })

  // stderr goes to its own callback as it arrives, as stdout goes to output.
  it('streams stderr to its callback', async () => {
    const seen: Uint8Array[] = []
    const r = await runProgram('sh', null, ['-c', 'echo o; echo e >&2; exit 3'], null, {
      errors: (chunk) => {
        seen.push(chunk)
        return Promise.resolve()
      },
    })
    expect([
      DEC.decode(r.stdout),
      DEC.decode(r.stderr ?? undefined),
      DEC.decode(Buffer.concat(seen)),
      r.exitCode,
    ]).toEqual(['o\n', '', 'e\n', 3])
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
    const result = await runProgram('wc', null, ['-c'], input(), { children })
    expect(result.exitCode).toBe(0)
    expect(Number(DEC.decode(result.stdout).trim())).toBe(5000 * 1024)
    expect(chunks).toBe(5000)
  })

  it('finishes an exited command with an open, idle managed stdin', async () => {
    const input = new ProcessInput()
    const result = await runProgram('sh', null, ['-c', 'printf done'], input.stream())
    expect(result.exitCode).toBe(0)
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
      const result = await runProgram('sh', null, ['-c', 'printf done'], input())
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'done'])
    } finally {
      release()
    }
  })

  it('aborts a command while its managed input pull is waiting', async () => {
    const input = new ProcessInput()
    const controller = new AbortController()
    const run = runProgram('sh', null, ['-c', 'exec sleep 30'], input.stream(), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await expect(input.write(new TextEncoder().encode('late'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it('rejects a missing program with its hint', async () => {
    await expect(runProgram('mirage-no-such-program', 'install it', [], null)).rejects.toThrow(
      'install it',
    )
  })

  it('kills the child when the call is aborted', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const run = runProgram('sh', 'no sh', ['-c', 'exec sleep 30'], null, {
      signal: controller.signal,
    })
    setTimeout(() => {
      controller.abort()
    }, 50)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills what the child started, which holds its pipes open', async () => {
    const controller = new AbortController()
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const run = runProgram('sh', null, ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], null, {
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
    const pidFile = join(mkdtempSync(join(tmpdir(), 'mirage-program-')), 'pid')
    const run = runProgram(process.execPath, null, ['-e', ESCAPE, pidFile], null, {
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
    const pidFile = join(mkdtempSync(join(tmpdir(), 'mirage-program-')), 'pid')
    const run = runProgram(process.execPath, null, ['-e', ESCAPE, pidFile], null, { children })
    const escaped = await escapedPid(pidFile)
    try {
      const started = Date.now()
      await closeChildren(children)
      expect((await run).exitCode).not.toBe(0)
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
    const run = runProgram('sh', null, ['-c', 'exit 0'], input, { children })
    const exited = Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => {
              resolve()
            })
          }),
      ),
    )
    await entered
    await exited
    await closeChildren(children)
    release()
    expect((await run).exitCode).toBe(0)
  })

  it('closeChildren kills every running tree and waits for it', async () => {
    const children = new Set<ChildProcess>()
    const run = runProgram('sh', null, ['-c', 'sleep 30 & wait'], null, { children })
    expect(children.size).toBe(1)
    const started = Date.now()
    await closeChildren(children)
    expect((await run).exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(children.size).toBe(0)
  })
})

// Children whose output nobody reads: one exits once its input closes,
// with a write still blocked in a thread; one stays blocked writing.
const UNREAD_THEN_EXIT = [
  'import os, sys, threading',
  "threading.Thread(target=os.write, args=(1, b'x' * (1 << 20)), daemon=True).start()",
  'sys.stdin.buffer.read()',
  'os._exit(0)',
].join('\n')
const UNREAD_FOREVER = "import os\nos.write(1, b'x' * (1 << 20))"

describe('openProgramPipe', () => {
  it('keeps the tail of its stderr', async () => {
    const pipe = await openProgramPipe(process.execPath, [
      '-e',
      "process.stderr.write('x'.repeat(40000) + 'the-end'); setTimeout(() => undefined, 30000)",
    ])
    let said = ''
    try {
      said = (await pipe.diagnostic?.()) ?? ''
      expect(said.endsWith('the-end')).toBe(true)
      expect(said.length).toBe(PIPE_DIAGNOSTIC_BYTES)
    } finally {
      await pipe.stop()
    }
    expect(await pipe.diagnostic?.()).toBe(said)
  })

  it.each([
    ['exits once its input closes', UNREAD_THEN_EXIT],
    ['never exits', UNREAD_FOREVER],
  ])('stops a command that %s without waiting on output nobody read', async (_name, script) => {
    const pipe = await openProgramPipe('python3', ['-c', script])
    await delay(500)
    const stopped = pipe.stop().then(() => 'stopped')
    expect(await Promise.race([stopped, delay(5000, 'stuck', { ref: false })])).toBe('stopped')
  })
})

describe('host runs', () => {
  // A host program a runtime keeps as its child is one of the runner's
  // native runs while it runs: this host, its PID and when it started, so a
  // workspace that outlives this one can stop it; it goes once it ended.
  it("keeps a kept child as one of its runner's native runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const children = new Set<ChildProcess>()
    const runner = new ProcessTable(runWithExecution).start({
      sessionId: 's',
      command: 'sh',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run: async () =>
        (
          await runProgram('sh', null, ['-c', `echo $$ > ${pidFile}; sleep 0.3`], null, {
            children,
          })
        ).exitCode,
    })
    const pid = await escapedPid(pidFile)
    const run = runner.runs[`host:${String(pid)}`]
    expect([run?.host, run?.pid, run?.command]).toEqual([
      hostname(),
      pid,
      `sh -c 'echo $$ > ${pidFile}; sleep 0.3'`,
    ])
    expect(Math.abs((run?.started_at as number) - Date.now() / 1000)).toBeLessThan(5)
    expect((await runner.join()).exitCode).toBe(0)
    expect(runner.runs).toEqual({})
  })

  // A run a lapsed workspace left on this host is stopped, its whole group,
  // while its PID still names the process it started; a PID that names a
  // later process, or a run of another host, is left alone.
  it('reaps a left host run only while it is the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const child = spawn(
      'sh',
      ['-c', `trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`],
      { detached: true, stdio: 'ignore' },
    )
    const exited = new Promise<string | null>((resolve) => {
      child.once('exit', (_code, signal) => {
        resolve(signal)
      })
    })
    const pid = await escapedPid(pidFile)
    const run = hostRun(pid, ['sh'])
    try {
      expect(await reapHostRun({ ...run, host: 'elsewhere' }, 15)).toBe(false)
      expect(await reapHostRun({ ...run, started_at: null }, 15)).toBe(false)
      expect(await reapHostRun({ ...run, started_at: 0 }, 15)).toBe(true)
      expect(child.exitCode === null && child.signalCode === null).toBe(true)
      expect(await reapHostRun(run, 15)).toBe(true)
      expect(await exited).toBe('SIGKILL')
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-pid, 'SIGKILL')
    }
  })

  // A run whose leader exited before the program it started is stopped too:
  // its group outlives the leader, and no new process takes its id meanwhile.
  it('reaps a left host run whose leader exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const child = spawn('sh', ['-c', `sleep 30 & echo $! > ${pidFile}`], {
      detached: true,
      stdio: 'ignore',
    })
    const run = hostRun(child.pid ?? 0, ['sh'])
    await new Promise((resolve) => child.once('exit', resolve))
    const survivor = await escapedPid(pidFile)
    const alive = (): boolean => {
      try {
        process.kill(survivor, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      expect(await reapHostRun(run, 15)).toBe(true)
      const deadline = Date.now() + 5000
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(alive()).toBe(false)
    } finally {
      if (alive()) process.kill(survivor, 'SIGKILL')
    }
  })

  // A group this workspace may not signal is out of its reach while its
  // leader still runs, so a workspace with the rights can stop it later.
  it('leaves a host run it may not signal out of reach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-program-'))
    const pidFile = join(dir, 'pid')
    const child = spawn('sh', ['-c', `echo $$ > ${pidFile}; while :; do sleep 0.05; done`], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = await escapedPid(pidFile)
    const kill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid)
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
      return kill(target, signal)
    })
    try {
      expect(await reapHostRun(hostRun(pid, ['sh']), 15)).toBe(false)
    } finally {
      spy.mockRestore()
      process.kill(-pid, 'SIGKILL')
      child.unref()
    }
  })
})
