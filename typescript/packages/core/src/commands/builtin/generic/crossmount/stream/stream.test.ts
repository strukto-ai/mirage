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

import { invoke } from '../../../../../io/stdio.ts'
import { closeQuietly } from '../../../../../io/stream.ts'
import { IOResult, materialize } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { Cmd, type RunSingle } from '../types.ts'
import { runStream } from './stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Call {
  cmd: string
  flags: Record<string, FlagValue>
}

// Serves bytes for some operands and a cat-voiced failure for others, and
// records what the run over the merged stream was handed. Mirrors
// FetchFailures in test_stream.py.
class Fetches {
  readonly calls: Call[] = []
  finalStdin: Uint8Array | null = null

  constructor(
    private readonly files: Record<string, string>,
    private readonly failures: Record<string, string> = {},
  ) {}

  readonly run: RunSingle = async (cmd, paths, _texts, flags, extra) => {
    this.calls.push({ cmd, flags: { ...flags } })
    const path = paths[0]?.virtual
    if (cmd === 'cat' && path !== undefined) {
      const failure = this.failures[path]
      if (failure !== undefined) {
        return [
          null,
          new IOResult({ exitCode: 1, stderr: ENC.encode(`cat: ${path}: ${failure}\n`) }),
        ]
      }
      return [ENC.encode(this.files[path] ?? ''), new IOResult()]
    }
    const stdin = extra?.stdin ?? null
    this.finalStdin = stdin === null ? null : await materialize(stdin)
    return [ENC.encode('FINAL'), new IOResult()]
  }
}

function scopes(...virtuals: string[]): PathSpec[] {
  return virtuals.map((virtual) => PathSpec.fromStrPath(virtual))
}

describe('runStream', () => {
  it('ends a line reader file at its boundary and keeps cat bytewise', async () => {
    const fetches = new Fetches({ '/a/x': 'ab', '/b/y': 'cd' })
    await runStream(Cmd.CUT, scopes('/a/x', '/b/y'), [], {}, fetches.run)
    expect(DEC.decode(fetches.finalStdin ?? undefined)).toBe('ab\ncd')
    await runStream(Cmd.CAT, scopes('/a/x', '/b/y'), [], { n: true }, fetches.run)
    expect(DEC.decode(fetches.finalStdin ?? undefined)).toBe('abcd')
  })
})

it('drains an owned failed fetch before merging stderr and skips its stdout', async () => {
  const run: RunSingle = async (_cmd, paths) => {
    const result = await invoke(() =>
      paths[0]?.virtual === '/b/missing'
        ? new IOResult({
            stdout: ENC.encode('discarded'),
            stderr: ENC.encode('cat: /b/missing: No such file or directory\n'),
            exitCode: 1,
          })
        : new IOResult({ stdout: ENC.encode('kept\n') }),
    )
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out, io] = await runStream(Cmd.CAT, scopes('/a/file', '/b/missing'), [], {}, run)
  expect(DEC.decode(await materialize(out))).toBe('kept\n')
  expect(await io.stderrStr()).toBe('cat: /b/missing: No such file or directory\n')
  expect(io.exitCode).toBe(1)
})

it('merges late fetch diagnostics and claims in operand order', async () => {
  const run: RunSingle = async (_cmd, paths) => {
    const path = paths[0]?.virtual ?? ''
    const io = new IOResult()
    async function* source(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(ENC.encode(`${path}\n`))
      io.stderr = ENC.encode(`cat: ${path}: late diagnostic\n`)
      io.reads[path] = ENC.encode('saved')
      io.cache.push(path)
      io.exitCode = 1
    }
    const result = await invoke(() => [source(), io])
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out, io] = await runStream(Cmd.CAT, scopes('/a/x', '/b/y'), [], {}, run)
  expect(DEC.decode(await materialize(out))).toBe('/a/x\n/b/y\n')
  expect(await io.stderrStr()).toBe('cat: /a/x: late diagnostic\ncat: /b/y: late diagnostic\n')
  expect(io.exitCode).toBe(1)
  expect(io.reads).toEqual({ '/a/x': ENC.encode('saved'), '/b/y': ENC.encode('saved') })
  expect(io.cache).toEqual(['/a/x', '/b/y'])
})

it('keeps the final command late diagnostic and status', async () => {
  const run: RunSingle = async (_cmd, paths, _texts, _flags, extra) => {
    const io = new IOResult()
    async function* source(): AsyncGenerator<Uint8Array> {
      yield await materialize(extra?.stdin ?? null)
      io.stderr = ENC.encode('cut: late diagnostic\n')
      io.exitCode = 7
    }
    const result = await invoke(() => [paths.length > 0 ? ENC.encode('kept\n') : source(), io])
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out, io] = await runStream(Cmd.CUT, scopes('/a/x'), [], {}, run)
  expect(DEC.decode(await materialize(out))).toBe('kept\n')
  expect(await io.stderrStr()).toBe('cut: late diagnostic\n')
  expect(io.exitCode).toBe(7)
})

it('closes every owned fetch before the first output pull', async () => {
  const closed: string[] = []
  const run: RunSingle = async (_cmd, paths) => {
    const path = paths[0]?.virtual ?? ''
    const result = await invoke(async (stdio) => {
      try {
        await stdio.stdout.write(ENC.encode('ready'))
        await stdio.waitCancelled()
        return null
      } finally {
        closed.push(path)
      }
    })
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out] = await runStream(Cmd.CAT, scopes('/a/x', '/b/y'), [], {}, run)
  await closeQuietly(out)
  expect(closed).toEqual(['/a/x', '/b/y'])
})

it('closes an unread fetch when sort fails and respells the diagnostic', async () => {
  let closed = false
  const run: RunSingle = async (_cmd, paths) => {
    const result = await invoke(async (stdio) => {
      if (paths[0]?.virtual === '/b/missing')
        return new IOResult({
          stderr: ENC.encode('cat: /b/missing: No such file or directory\n'),
          exitCode: 1,
        })
      try {
        await stdio.stdout.write(ENC.encode('unread'))
        await stdio.waitCancelled()
        return null
      } finally {
        closed = true
      }
    })
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out, io] = await runStream(Cmd.SORT, scopes('/a/x', '/b/missing'), [], {}, run)
  expect(out).toBeNull()
  expect(closed).toBe(true)
  expect(io.exitCode).toBe(2)
  expect(await io.stderrStr()).toBe('sort: /b/missing: No such file or directory\n')
})

it('closes while the next fetch pull is pending', async () => {
  const closed: string[] = []
  const run: RunSingle = async (_cmd, paths) => {
    const path = paths[0]?.virtual ?? ''
    const result = await invoke(async (stdio) => {
      try {
        await stdio.stdout.write(ENC.encode(path))
        await stdio.waitCancelled()
        return null
      } finally {
        closed.push(path)
      }
    })
    if (result === null) throw new Error('handler declined')
    return result
  }
  const [out] = await runStream(Cmd.CAT, scopes('/a/x', '/b/y'), [], {}, run)
  if (out === null || out instanceof Uint8Array) throw new Error('missing stream')
  const iterator = out[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: ENC.encode('/a/x') })
  const pending = iterator.next()
  const settled = pending.catch(() => undefined)
  await Promise.resolve()
  await closeQuietly(out)
  await settled
  expect(closed.sort()).toEqual(['/a/x', '/b/y'])
})
