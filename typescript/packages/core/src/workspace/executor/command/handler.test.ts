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
import type { CommandFnResult } from '../../../commands/config.ts'
import { PartialOutputError, UsageError } from '../../../commands/errors.ts'
import { enoent } from '../../../errors/fs.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { IOResult, materialize, type ByteSource, type Rows } from '../../../io/types.ts'
import { PathSpec, type Producer } from '../../../types.ts'
import { cliVoice, mountVoice, runHandler, type RunHandlerOpts } from './handler.ts'

const ENC = new TextEncoder()
const PRODUCER: Producer = { command: 'cat', prefixes: ['/data/'], declared: null }
const MOUNT = mountVoice('cat', [])
const LEAF = cliVoice('gh')
const TYPED = mountVoice('cat', [PathSpec.fromStrPath('notes.md', undefined, '/data')])

function answer(stdout: ByteSource | null): Promise<CommandFnResult> {
  return Promise.resolve([stdout, new IOResult()])
}

async function* stream(chunks: readonly string[], error?: Error): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield ENC.encode(chunk)
  }
  if (error !== undefined) throw error
}

function run(
  body: Promise<CommandFnResult>,
  voice = LEAF,
  opts: RunHandlerOpts = {},
): Promise<CommandFnResult> {
  return runHandler(body, 'x', PRODUCER, voice, opts)
}

async function text(source: ByteSource | null | undefined): Promise<string> {
  return new TextDecoder().decode(await materialize(source ?? null))
}

class Drops {
  count = 0
  drop = (): Promise<void> => {
    this.count += 1
    return Promise.resolve()
  }
}

describe('runHandler', () => {
  it.each([
    ['a usage error', new UsageError('bad', 2), LEAF, 2, 'bad\n'],
    ['a failure', new Error('boom'), LEAF, 1, 'gh: boom\n'],
    [
      'a typed path like GNU',
      enoent('/data/notes.md'),
      TYPED,
      1,
      'cat: notes.md: No such file or directory\n',
    ],
  ])("drops after %s and words it in the caller's voice", async (_, error, voice, code, stderr) => {
    const drops = new Drops()
    const out = await run(Promise.reject(error), voice, { drop: drops.drop })
    expect(out?.[0]).toBeNull()
    expect([out?.[1].exitCode, await text(out?.[1].stderr), out?.[1].producer]).toEqual([
      code,
      stderr,
      null,
    ])
    expect(drops.count).toBe(1)
  })

  it('lets a closed pipe from a mount reach the executor after the drop', async () => {
    const drops = new Drops()
    await expect(
      run(Promise.reject(new PipeClosed()), MOUNT, { drop: drops.drop }),
    ).rejects.toBeInstanceOf(PipeClosed)
    expect(drops.count).toBe(1)
  })

  it.each([
    ['a stream', true, false],
    ['a stream closed early', true, true],
    ['bytes', false, false],
  ])('drops once it answers %s, and again once a stream ends', async (_, lazy, early) => {
    const drops = new Drops()
    const stdout = lazy ? stream(['a\n', 'b\n']) : ENC.encode('a\nb\n')
    const out = await run(answer(stdout), LEAF, { drop: drops.drop })
    expect(drops.count).toBe(1)
    if (early) {
      const pulled = out?.[0] as AsyncIterableIterator<Uint8Array>
      expect((await pulled.next()).value).toEqual(ENC.encode('a\n'))
      await pulled.return?.()
    } else {
      expect(await text(out?.[0])).toBe('a\nb\n')
    }
    expect(drops.count).toBe(lazy ? 2 : 1)
  })

  it.each([
    ['as a mount', MOUNT, new Error('lost'), 'a\n', 'cat: lost\n'],
    ['as a leaf', LEAF, new PartialOutputError('cut', ENC.encode('b\n')), 'a\nb\n', 'gh: cut\n'],
  ])(
    'stamps the producer on an answer and words a deferred failure %s',
    async (_, voice, error, stdout, stderr) => {
      const out = await run(answer(stream(['a\n'], error)), voice)
      expect(out?.[1].producer).toBe(PRODUCER)
      expect(await text(out?.[0])).toBe(stdout)
      expect(await text(out?.[1].stderr)).toBe(stderr)
      expect(out?.[1].exitCode).toBe(1)
    },
  )
})

describe('runHandler with rows', () => {
  it('holds and drops caches until a renderer past its abort settles', async () => {
    // A renderer cannot be cancelled, so what the caller holds for the
    // handler (a CLI's client) is kept until the rendered answer settles, a
    // write it makes late is followed by a cache drop, and the stream it
    // hands back with no reader left is closed.
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let closed = 0
    const late: AsyncIterableIterator<Uint8Array> = {
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: () => {
        closed += 1
        return Promise.resolve({ done: true, value: undefined })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    const rows: Rows = {
      items: [],
      render: async () => {
        await gate
        return late
      },
    }
    let settled = 0
    const drops = new Drops()
    const abort = new AbortController()
    abort.abort()
    const out = runHandler(Promise.resolve([null, new IOResult({ rows })]), 'x', PRODUCER, LEAF, {
      drop: drops.drop,
      settle: () => {
        settled += 1
      },
      signal: abort.signal,
    })
    await expect(out).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([settled, drops.count]).toEqual([0, 1])
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([settled, closed, drops.count]).toEqual([1, 1, 2])
  })

  it('reports a drop that fails once a body past its abort settles', async () => {
    let calls = 0
    const drop = (): Promise<void> => {
      calls += 1
      return calls === 1 ? Promise.resolve() : Promise.reject(new Error('torn down'))
    }
    let finish: () => void = () => undefined
    const body = new Promise<CommandFnResult>((resolve) => {
      finish = () => {
        resolve([null, new IOResult()])
      }
    })
    const abort = new AbortController()
    abort.abort()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(run(body, LEAF, { drop, signal: abort.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
      finish()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toBe(2)
      expect(unhandled).toEqual([])
      expect(warn).toHaveBeenCalledWith('x: cache drop after timeout failed: torn down')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      warn.mockRestore()
    }
  })
})
