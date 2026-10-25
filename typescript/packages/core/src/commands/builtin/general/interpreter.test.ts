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
import { materialize } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import type { OutputFn, RunResult } from '../../../runtime/types.ts'
import { STOP_WAIT_SECONDS } from '../../../shell/job_table/constants.ts'
import { ABORT_JOIN_MS } from '../../../utils/abort.ts'
import type { Context } from '../../config.ts'
import { runInterpreter, runOutput } from './interpreter.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function ran(): Promise<RunResult> {
  return Promise.resolve({ stdout: ENC.encode('out'), stderr: ENC.encode('err'), exitCode: 3 })
}

async function outThenErr(output: OutputFn, errors: OutputFn): Promise<RunResult> {
  await output(ENC.encode('a'))
  await errors(ENC.encode('e'))
  return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
}

function saidOnStderr(): Promise<RunResult> {
  return Promise.resolve({ stdout: new Uint8Array(), stderr: ENC.encode('run\n'), exitCode: 0 })
}

/** An input that ends at once and records its close. */
class Input implements AsyncIterableIterator<Uint8Array> {
  closed = false

  next(): Promise<IteratorResult<Uint8Array>> {
    return Promise.resolve({ done: true, value: undefined })
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    this.closed = true
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('runInterpreter', () => {
  // A kill reaches the interpreter as an abort, which stops the job that
  // ran it; it is no failure of the program's to report on stderr.
  it('lets an abort through rather than reporting it', async () => {
    const abort = new AbortController()
    abort.abort()
    const runtime = {
      execute: () => Promise.reject(new DOMException('execute aborted', 'AbortError')),
    } as unknown as LanguageRuntime
    const ctx = { signal: abort.signal } as unknown as Context
    const out = runInterpreter('python3', runtime, [], [], ctx, null)
    await expect(materialize(out?.[0])).rejects.toMatchObject({ name: 'AbortError' })
  })

  // The run starts as its output is read, so the workspace settles the
  // runtime once that run has ended, not when the command returns.
  it('settles the runtime once the run ends', async () => {
    const said: string[] = []
    const runtime = {
      execute: () => {
        said.push('ran')
        return Promise.resolve({ stdout: ENC.encode('x'), stderr: null, exitCode: 0 })
      },
    } as unknown as LanguageRuntime
    const settle = (): Promise<void> => {
      said.push('settled')
      return Promise.resolve()
    }
    const ctx = { stdin: null, runtime: { execAllowed: true, settle } } as unknown as Context
    const out = runInterpreter('python3', runtime, [], [], ctx, null)
    expect(said).toEqual([])
    expect(DEC.decode(await materialize(out?.[0]))).toBe('x')
    expect(said).toEqual(['ran', 'settled'])
  })
})

describe('runOutput', () => {
  it('settles the status and stderr as its output ends', async () => {
    const [stdout, io] = runOutput(ran)
    expect(io.output?.settled).toBe(false)
    expect(DEC.decode(await materialize(stdout))).toBe('out')
    expect([io.exitCode, DEC.decode(await materialize(io.stderr))]).toEqual([3, 'err'])
    expect(io.output?.settled).toBe(true)
  })

  it('hands each write over as the run makes it', async () => {
    let release = (): void => undefined
    const later = new Promise<void>((resolve) => {
      release = resolve
    })
    const [stdout] = runOutput(async (output) => {
      await output(ENC.encode('first\n'))
      await later
      await output(ENC.encode('second\n'))
      return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
    })
    expect(DEC.decode((await stdout.next()).value as Uint8Array)).toBe('first\n')
    release()
    expect(DEC.decode(await materialize(stdout))).toBe('second\n')
  })

  it('holds the run back while its reader is behind', async () => {
    let wrote = false
    const [stdout] = runOutput(async (output) => {
      await output(new Uint8Array(1 << 20))
      wrote = true
      return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
    })
    const first = (await stdout.next()).value as Uint8Array
    for (let i = 0; i < 20; i++) await tick()
    expect(wrote).toBe(false)
    const rest = await materialize(stdout)
    expect(first.byteLength + rest.byteLength).toBe(1 << 20)
    expect(wrote).toBe(true)
  })

  it('stops the run when its reader goes away', async () => {
    let stopped = false
    const input = new Input()
    const [stdout, io] = runOutput(
      async (output, _errors, signal) => {
        await output(ENC.encode('a'))
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve()
          })
        })
        stopped = true
        return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
      },
      null,
      undefined,
      input,
    )
    expect(DEC.decode((await stdout.next()).value as Uint8Array)).toBe('a')
    await stdout.return()
    expect(stopped).toBe(true)
    expect(io.exitCode).toBe(141)
    expect(input.closed).toBe(true)
  })

  it('keeps the stderr a stopped run had written', async () => {
    const [stdout, io] = runOutput(async (output, errors, signal) => {
      await errors(ENC.encode('warn\n'))
      await output(ENC.encode('a'))
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
      })
      return { stdout: new Uint8Array(), stderr: ENC.encode('late\n'), exitCode: 0 }
    })
    expect(DEC.decode((await stdout.next()).value as Uint8Array)).toBe('a')
    await stdout.return()
    expect([io.exitCode, DEC.decode(await materialize(io.stderr))]).toEqual([141, 'warn\nlate\n'])
  })

  // A sandbox reaps its program after the stop, and the runtime settles
  // after that, so the reader waits for both before the next command.
  it('waits for a stopped run that takes its time to end', async () => {
    let ended = false
    const [stdout] = runOutput(async (output, _errors, signal) => {
      await output(ENC.encode('a'))
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(resolve, ABORT_JOIN_MS * 2)
        })
      })
      ended = true
      return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
    })
    await stdout.next()
    await stdout.return()
    expect(ended).toBe(true)
  })

  // A promise cannot be cancelled, so a run that never looks at its stop is
  // given the stop bound and then left running.
  it('lets its reader go when a stopped run ignores the stop', async () => {
    vi.useFakeTimers()
    try {
      const [stdout, io] = runOutput(async (output) => {
        await output(ENC.encode('a'))
        return new Promise<RunResult>(() => undefined)
      })
      expect(DEC.decode((await stdout.next()).value as Uint8Array)).toBe('a')
      let released = false
      const closing = stdout.return().then(() => {
        released = true
      })
      await vi.advanceTimersByTimeAsync(STOP_WAIT_SECONDS * 1000 - 1)
      expect(released).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await closing
      expect(io.exitCode).toBe(141)
      expect(io.output?.settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps each stderr write as it was written', async () => {
    const [stdout, io] = runOutput(async (_output, errors) => {
      const scratch = ENC.encode('one\n')
      await errors(scratch)
      scratch.set(ENC.encode('two\n'))
      await errors(scratch)
      return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
    })
    await materialize(stdout)
    expect(DEC.decode(await materialize(io.stderr))).toBe('one\ntwo\n')
  })

  it('writes stderr after the stdout before it', async () => {
    const seen: [string, string][] = []
    const errors = (chunk: Uint8Array): Promise<void> => {
      seen.push(['err', DEC.decode(chunk)])
      return Promise.resolve()
    }
    const [stdout, io] = runOutput(outThenErr, null, errors)
    for await (const chunk of stdout) seen.push(['out', DEC.decode(chunk)])
    expect(seen).toEqual([
      ['out', 'a'],
      ['err', 'e'],
    ])
    expect(io.stderr).toBeNull()
  })

  it('keeps what the result already said on stderr', async () => {
    const [stdout, io] = runOutput(saidOnStderr)
    io.stderr = ENC.encode('warning\n')
    await materialize(stdout)
    expect(DEC.decode(await materialize(io.stderr))).toBe('warning\nrun\n')
  })
})
