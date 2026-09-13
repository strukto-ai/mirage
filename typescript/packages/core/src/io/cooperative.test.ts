/* eslint-disable @typescript-eslint/require-await -- Immediately ready producers reproduce event-loop starvation. */
import { RAMFileCacheStore } from '../cache/file/ram.ts'
import { describe, expect, it } from 'vitest'
import { AsyncLineIterator } from './async_line_iterator.ts'
import { chunks } from './cooperative.ts'
import { wcGeneric } from '../commands/builtin/generic/wc.ts'

const ENC = new TextEncoder()

describe('cooperative processing', () => {
  it('lets timers run during direct readline calls', async () => {
    let fired = false
    const timer = setTimeout(() => {
      fired = true
    }, 1)
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('line\n'.repeat(500_000))
    }
    try {
      const reader = new AsyncLineIterator(source())
      for (let i = 0; i < 500_000; i++) await reader.readline()
      expect(fired).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  })

  it('aborts wc and closes its producer before returning', async () => {
    const controller = new AbortController()
    let closed = false
    async function* source(): AsyncIterable<Uint8Array> {
      try {
        yield ENC.encode('line\n'.repeat(500_000))
      } finally {
        closed = true
      }
    }
    const timer = setTimeout(() => {
      controller.abort()
    }, 1)
    try {
      await expect(
        wcGeneric(
          [],
          [],
          {
            stdin: source(),
            flags: {},
            cwd: '/',
            filetypeFns: null,
            signal: controller.signal,
          },
          source,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(closed).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  })
})

it('preserves UTF-8 and words across bounded chunks', async () => {
  const text = 'a'.repeat(16_383) + 'é x\n'
  const result = await wcGeneric(
    [],
    [],
    {
      stdin: ENC.encode(text),
      cwd: '/',
      filetypeFns: null,
      flags: { lines: true, words: true, bytes: true, chars: true, max_line_length: true },
    },
    async function* () {
      yield new Uint8Array()
    },
  )
  if (result === null) throw new Error('wc returned no result')
  const [out] = result
  const { materialize } = await import('./types.ts')
  const values = new TextDecoder()
    .decode(await materialize(out))
    .trim()
    .split(/\s+/)
    .map(Number)
  expect(values).toEqual([1, 2, 16_387, 16_388, 16_386])
})

it('preserves a long line and its unterminated tail', async () => {
  async function* source(): AsyncIterable<Uint8Array> {
    yield ENC.encode('x'.repeat(100_000) + '\nlast')
  }
  const reader = new AsyncLineIterator(source())
  expect((await reader.readline())?.byteLength).toBe(100_000)
  expect(new TextDecoder().decode((await reader.readline()) ?? undefined)).toBe('last')
  expect(await reader.readline()).toBeNull()
})

it('allows timer progress while populating a file-cache fingerprint', async () => {
  const cache = new RAMFileCacheStore()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
  }, 1)
  try {
    await cache.set('/big', new Uint8Array(20_000_000))
    expect(fired).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})

it.each(['set', 'add'] as const)(
  'discards a pending %s when the cache is cleared',
  async (operation) => {
    const cache = new RAMFileCacheStore()
    const pending = cache[operation]('/large', new Uint8Array(20_000_000))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cache.clear()
    await pending
    expect(await cache.get('/large')).toBeNull()
    expect(cache.cacheSize).toBe(0)
  },
)

it.each(['mapfile values', 'read -N 131072 value'])(
  'aborts %s while consuming ready stdin and closes the producer',
  async (command) => {
    const { Workspace } = await import('../workspace/workspace/workspace.ts')
    const { getTestParser } = await import('../workspace/fixtures/workspace_fixture.ts')
    const ws = new Workspace({}, { shellParser: await getTestParser() })
    const controller = new AbortController()
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function* source(): AsyncIterable<Uint8Array> {
      try {
        timer = setTimeout(() => {
          controller.abort()
        }, 0)
        yield ENC.encode('line\n'.repeat(200_000))
      } finally {
        closed = true
      }
    }
    try {
      await expect(
        ws.execute(command, { stdin: source(), signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(closed).toBe(true)
      const events = await ws.observer.commandEvents()
      expect(events).toHaveLength(1)
      expect(events[0]?.exit_code).toBe(130)
    } finally {
      clearTimeout(timer)
      await ws.close()
    }
  },
)

it('uses the current read signal when reusing buffered stdin', async () => {
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      yield ENC.encode('first\nsecond\nthird\n')
    } finally {
      closed = true
    }
  }
  const reader = new AsyncLineIterator(source())
  const previous = new AbortController()
  expect(new TextDecoder().decode((await reader.readUntil(10, previous.signal))[0])).toBe('first')
  previous.abort()
  const current = new AbortController()
  expect(new TextDecoder().decode((await reader.readUntil(10, current.signal))[0])).toBe('second')
  current.abort()
  await expect(reader.readUntil(10, current.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(closed).toBe(true)
})

it('discards cacheable input when a chunk yield aborts', async () => {
  const { CachableAsyncIterator } = await import('./cachable_iterator.ts')
  const { chunks } = await import('./cooperative.ts')
  let closed = false
  async function* source() {
    try {
      yield new Uint8Array(100_000)
    } finally {
      closed = true
    }
  }
  const input = new CachableAsyncIterator(source())
  const controller = new AbortController()
  await expect(
    (async () => {
      for await (const part of chunks(input, controller.signal)) {
        expect(part.length).toBeGreaterThan(0)
        controller.abort()
      }
    })(),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(closed).toBe(true)
  expect(input.bufferedChunks).toHaveLength(0)
})

it.each(['mapfile values', 'read -N 131072 value', 'cat | wc -l'])(
  'discards cacheable stdin on %s cancellation',
  async (command) => {
    const { Workspace } = await import('../workspace/workspace/workspace.ts')
    const { getTestParser } = await import('../workspace/fixtures/workspace_fixture.ts')
    const { CachableAsyncIterator } = await import('./cachable_iterator.ts')
    const ws = new Workspace({}, { shellParser: await getTestParser() })
    const controller = new AbortController()
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function* source() {
      try {
        timer = setTimeout(() => {
          controller.abort()
        }, 0)
        yield ENC.encode('line\n'.repeat(command.startsWith('cat') ? 4_000_000 : 200_000))
      } finally {
        closed = true
      }
    }
    const input = new CachableAsyncIterator(source())
    try {
      await expect(
        ws.execute(command, { stdin: input, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(closed).toBe(true)
      expect(input.bufferedChunks).toHaveLength(0)
    } finally {
      clearTimeout(timer)
      await ws.close()
    }
  },
)

it('never caches partial content after a producer fails', async () => {
  const { CachableAsyncIterator } = await import('./cachable_iterator.ts')
  const { applyIo } = await import('../cache/file/io.ts')
  const { IOResult } = await import('./types.ts')
  async function* source() {
    yield ENC.encode('partial')
    throw new Error('read failed')
  }
  const input = new CachableAsyncIterator(source())
  await input.next()
  await expect(input.next()).rejects.toThrow('read failed')
  const cache = new RAMFileCacheStore()
  await applyIo(cache, new IOResult({ reads: { '/bad': input }, cache: ['/bad'] }))
  expect(await cache.get('/bad')).toBeNull()
  expect(cache.drainTasks.size).toBe(0)
})

it('discards hidden cache reads when a value barrier fails', async () => {
  const { CachableAsyncIterator } = await import('./cachable_iterator.ts')
  const { IOResult } = await import('./types.ts')
  const { applyBarrier, BarrierPolicy } = await import('../shell/barrier.ts')
  let closed = false
  async function* source() {
    try {
      yield ENC.encode('partial')
    } finally {
      closed = true
    }
  }
  const input = new CachableAsyncIterator(source())
  async function* output() {
    const step = await input.next()
    if (!step.done) yield step.value
    throw new Error('consumer failed')
  }
  const io = new IOResult({ reads: { '/remote': input }, cache: ['/remote'] })
  await expect(applyBarrier(output(), io, BarrierPolicy.VALUE)).rejects.toThrow('consumer failed')
  expect(closed).toBe(true)
  expect(input.bufferedChunks).toHaveLength(0)
})

it.each(['timeout', 'read failure'])('records %s while finalizing a shell reader', async (kind) => {
  const { Workspace } = await import('../workspace/workspace/workspace.ts')
  const { getTestParser } = await import('../workspace/fixtures/workspace_fixture.ts')
  const { CommandTimeoutError } = await import('../commands/errors.ts')
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  async function* source() {
    yield ENC.encode('partial\n')
    throw kind === 'timeout' ? new CommandTimeoutError('mapfile', 1) : new Error('read failed')
  }
  try {
    const result = await ws.execute('mapfile values', { stdin: source() })
    const code = kind === 'timeout' ? 124 : 1
    expect(result.exitCode).toBe(code)
    const events = await ws.observer.commandEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.exit_code).toBe(code)
  } finally {
    await ws.close()
  }
})

it('preserves a caller-supplied abort reason and records cancellation', async () => {
  const { Workspace } = await import('../workspace/workspace/workspace.ts')
  const { getTestParser } = await import('../workspace/fixtures/workspace_fixture.ts')
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  const controller = new AbortController()
  const reason = new Error('caller stopped the run')
  let timer: ReturnType<typeof setTimeout> | undefined
  async function* source() {
    timer = setTimeout(() => {
      controller.abort(reason)
    }, 0)
    yield ENC.encode('line\n'.repeat(200_000))
  }
  try {
    await expect(
      ws.execute('mapfile values', { stdin: source(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', cause: reason })
    const events = await ws.observer.commandEvents()
    expect(events[0]?.exit_code).toBe(130)
  } finally {
    clearTimeout(timer)
    await ws.close()
  }
})

describe('chunks under a stalled source', () => {
  it('lets the abort win over a pull that never settles', async () => {
    let closed = false
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => {
          closed = true
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }),
    }
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 20)
    const reader = chunks(stalled, controller.signal)
    await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(closed).toBe(true)
  })

  it('lets the abort win over a source that yields only empty chunks', async () => {
    // Every pull resolves at once with no bytes, so the per-chunk
    // yield never runs; without one per pull the microtask chain
    // starves the timer that fires the abort.
    let pulls = 0
    const empties: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          pulls++
          return Promise.resolve(
            pulls > 2_000_000
              ? { done: false as const, value: new TextEncoder().encode('late') }
              : { done: false as const, value: new Uint8Array(0) },
          )
        },
      }),
    }
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 20)
    const reader = chunks(empties, controller.signal)
    await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' })
    // Landed during the run, not after it had been pulled to its end.
    expect(pulls).toBeLessThan(2_000_000)
  })

  it('does not wait for a cache discard queued behind the stalled pull', async () => {
    const { CachableAsyncIterator } = await import('./cachable_iterator.ts')
    // An async generator queues `return()` behind its pending `next()`, so
    // the discard of the cache wrapper can only settle once the pull does.
    async function* stalled(): AsyncGenerator<Uint8Array> {
      await new Promise<never>(() => undefined)
      yield new Uint8Array(0)
    }
    const input = new CachableAsyncIterator(stalled())
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 20)
    const reader = chunks(input, controller.signal)
    await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(input.discarded).toBe(true)
  })
})

it('answers a timeout signal with an AbortError that carries the timeout', async () => {
  const { Workspace } = await import('../workspace/workspace/workspace.ts')
  const { getTestParser } = await import('../workspace/fixtures/workspace_fixture.ts')
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  async function* source() {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      yield ENC.encode('line\n'.repeat(20_000))
    }
  }
  try {
    const failure = await ws
      .execute('mapfile values', { stdin: source(), signal: AbortSignal.timeout(30) })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect((failure as { cause?: unknown }).cause).toMatchObject({ name: 'TimeoutError' })
  } finally {
    await ws.close()
  }
})
