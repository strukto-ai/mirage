import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from './cooperative.ts'
import { invoke } from './stdio.ts'
import { IOResult, materialize } from './types.ts'

const enc = new TextEncoder()

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected an admitted invocation')
  return value
}

describe('handler stdio', () => {
  it('bounds interleaved writes and settles final metadata after output', async () => {
    const events: [string, Uint8Array][] = []
    let done = false
    const result = await invoke(async (stdio) => {
      await stdio.stdout.write(new Uint8Array(CHUNK_SIZE * 8).fill(97))
      await stdio.stderr.write(new Uint8Array(CHUNK_SIZE * 8).fill(101))
      await stdio.stdout.write(enc.encode('z'))
      done = true
      return new IOResult({ exitCode: 7, countedRuns: [{ values: [1], label: '/a' }] })
    })
    const [source, io] = present(result)
    expect(done).toBe(false)
    present(io.output).stderr = (data) => {
      events.push(['stderr', data])
      return Promise.resolve()
    }
    for await (const data of source as AsyncIterable<Uint8Array>) {
      expect(data.byteLength).toBeLessThanOrEqual(CHUNK_SIZE)
      events.push(['stdout', data])
    }
    expect(done).toBe(true)
    expect(io.exitCode).toBe(7)
    expect(io.countedRuns).toEqual([{ values: [1], label: '/a' }])
    expect(
      events
        .filter(([channel]) => channel === 'stdout')
        .reduce((total, [, data]) => total + data.byteLength, 0),
    ).toBe(CHUNK_SIZE * 8 + 1)
    expect(
      events
        .filter(([channel]) => channel === 'stderr')
        .reduce((total, [, data]) => total + data.byteLength, 0),
    ).toBe(CHUNK_SIZE * 8)
    expect(events.at(-1)).toEqual(['stdout', enc.encode('z')])
  })

  it('preserves a prefix and captured stderr before a late failure', async () => {
    const [source, io] = present(
      await invoke(async (stdio) => {
        await stdio.stdout.write(enc.encode('prefix'))
        await stdio.stderr.write(enc.encode('warning'))
        throw new Error('late')
      }),
    )
    const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(enc.encode('prefix'))
    await expect(iterator.next()).rejects.toThrow('late')
    expect(await io.materializeStderr()).toEqual(enc.encode('warning'))
  })

  it('cancels and joins stalled input when the consumer closes', async () => {
    let closed = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const stdin: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await waiting
            return { done: true, value: undefined }
          },
          return() {
            closed = true
            release()
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }
    const [source] = present(
      await invoke(async (stdio) => {
        await stdio.stdout.write(enc.encode('prefix'))
        for await (const data of stdio.stdin) await stdio.stdout.write(data)
        return null
      }, stdin),
    )
    const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(enc.encode('prefix'))
    await iterator.return?.()
    expect(closed).toBe(true)
  })

  it('owns returned output and preserves eager metadata', async () => {
    const expected = new IOResult({ stderr: enc.encode('diagnostic'), exitCode: 3 })
    const [source, io] = present(await invoke(() => expected))
    expect(io.exitCode).toBe(3)
    expect(io.output?.settled).toBe(false)
    expect(await materialize(source)).toEqual(new Uint8Array())
    expect(io.output?.settled).toBe(true)
    expect(await materialize(io.stderr)).toEqual(enc.encode('diagnostic'))
  })
})

it('joins producer cleanup even before the first output pull', async () => {
  let closed = false
  const [source] = present(
    await invoke(async (stdio) => {
      try {
        await stdio.stdout.write(enc.encode('prefix'))
        await stdio.waitCancelled()
        return null
      } finally {
        closed = true
      }
    }),
  )
  await (source as AsyncIterableIterator<Uint8Array>).return?.()
  expect(closed).toBe(true)
})

it('closes a pending output pull before joining the generator', async () => {
  let closed = false
  const [source] = present(
    await invoke(async (stdio) => {
      try {
        await stdio.stdout.write(enc.encode('prefix'))
        await stdio.waitCancelled()
        return null
      } finally {
        closed = true
      }
    }),
  )
  const iterator = source as AsyncIterableIterator<Uint8Array>
  expect((await iterator.next()).value).toEqual(enc.encode('prefix'))
  const pending = iterator.next()
  await iterator.return?.()
  await pending
  expect(closed).toBe(true)
})

it.each([true, false])('joins partially consumed stdin without output (null=%s)', async (none) => {
  let closed = false
  async function* stdin(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    try {
      yield enc.encode('first')
      yield enc.encode('last')
    } finally {
      closed = true
    }
  }
  await invoke(async (stdio) => {
    expect((await stdio.stdin[Symbol.asyncIterator]().next()).value).toEqual(enc.encode('first'))
    return none ? null : new IOResult()
  }, stdin())
  expect(closed).toBe(true)
})

it.each(['stdout', 'stderr'] as const)('retains stdin for lazy returned %s', async (channel) => {
  let closed = false
  async function* stdin(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    try {
      yield enc.encode('first')
      yield enc.encode('last')
    } finally {
      closed = true
    }
  }
  const [source, io] = present(
    await invoke(async (stdio) => {
      expect((await stdio.stdin[Symbol.asyncIterator]().next()).value).toEqual(enc.encode('first'))
      return new IOResult({ [channel]: stdio.stdin })
    }, stdin()),
  )
  expect(closed).toBe(false)
  const stdout = await materialize(source)
  expect(channel === 'stdout' ? stdout : await materialize(io.stderr)).toEqual(enc.encode('last'))
  expect(closed).toBe(true)
})

it('orders native and returned output and delegates lazy exit status', async () => {
  const outcome = new IOResult()
  const events: [string, Uint8Array][] = []
  async function* returned(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(enc.encode('returned'))
    outcome.exitCode = 9
  }
  const [source, io] = present(
    await invoke(async (stdio) => {
      await stdio.stdout.write(enc.encode('written'))
      await stdio.stderr.write(enc.encode('warning'))
      outcome.stderr = enc.encode('returned error')
      return [returned(), outcome]
    }),
  )
  present(io.output).stderr = (data) => {
    events.push(['stderr', data])
    return Promise.resolve()
  }
  for await (const data of source as AsyncIterable<Uint8Array>) events.push(['stdout', data])
  expect(events.map(([stream, data]) => [stream, new TextDecoder().decode(data)])).toEqual([
    ['stdout', 'written'],
    ['stderr', 'warning'],
    ['stdout', 'returned'],
    ['stderr', 'returned error'],
  ])
  expect(io.exitCode).toBe(9)
})

it('finishes eager failures and declined handlers before publication', async () => {
  await expect(
    invoke(() => {
      throw new Error('eager')
    }),
  ).rejects.toThrow('eager')
  expect(await invoke(() => null)).toBeNull()
})

it('publishes late returned diagnostics and metadata once', async () => {
  const outcome = new IOResult({ countedRuns: [{ values: [1], label: 'early' }] })
  const finalized: unknown[] = []
  async function* returned(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(enc.encode('prefix'))
    outcome.stderr = enc.encode('late diagnostic')
    outcome.countedRuns = [{ values: [3], label: 'late' }]
    outcome.exitCode = 5
  }
  const [source, io] = present(await invoke(() => [returned(), outcome]))
  expect(io.countedRuns).toEqual([{ values: [1], label: 'early' }])
  present(io.output).callbacks.push(() => {
    finalized.push(io.countedRuns)
  })
  expect(await materialize(source)).toEqual(enc.encode('prefix'))
  expect(await materialize(io.stderr)).toEqual(enc.encode('late diagnostic'))
  expect(io.countedRuns).toEqual([{ values: [3], label: 'late' }])
  expect(io.exitCode).toBe(5)
  expect(finalized).toEqual([[{ values: [3], label: 'late' }]])
  await (source as AsyncIterableIterator<Uint8Array>).return?.()
  expect(finalized).toHaveLength(1)
})

it('retains returned stderr when stdout fails', async () => {
  async function* returned(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(enc.encode('prefix'))
    throw new Error('late')
  }
  const [source, io] = present(
    await invoke(() => [returned(), new IOResult({ stderr: enc.encode('diagnostic') })]),
  )
  const iterator = source as AsyncIterableIterator<Uint8Array>
  expect((await iterator.next()).value).toEqual(enc.encode('prefix'))
  await expect(iterator.next()).rejects.toThrow('late')
  expect(await materialize(io.stderr)).toEqual(enc.encode('diagnostic'))
})

it('retains cleanup diagnostics and finalizes once on early close', async () => {
  const outcome = new IOResult({ exitCode: 1 })
  const finalized: unknown[] = []
  async function* returned(): AsyncGenerator<Uint8Array> {
    try {
      yield await Promise.resolve(enc.encode('first'))
      yield enc.encode('second')
    } finally {
      outcome.stderr = enc.encode('finished')
      outcome.countedRuns = [{ values: [1], label: 'cleanup' }]
      outcome.exitCode = 0
    }
  }
  const [source, io] = present(await invoke(() => [returned(), outcome]))
  present(io.output).callbacks.push(() => {
    finalized.push(io.countedRuns)
  })
  const iterator = source as AsyncIterableIterator<Uint8Array>
  expect((await iterator.next()).value).toEqual(enc.encode('first'))
  await iterator.return?.()
  expect(io.stderr).toEqual(enc.encode('finished'))
  expect(io.exitCode).toBe(0)
  expect(finalized).toEqual([[{ values: [1], label: 'cleanup' }]])
})

it('cancels returned output without waiting for a stderr reader', async () => {
  const controller = new AbortController()
  async function* returned(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(enc.encode('prefix'))
    yield enc.encode('second')
  }
  const [source] = present(
    await invoke(
      () => [returned(), new IOResult({ stderr: enc.encode('diagnostic') })],
      null,
      controller.signal,
    ),
  )
  const iterator = source as AsyncIterableIterator<Uint8Array>
  expect((await iterator.next()).value).toEqual(enc.encode('prefix'))
  controller.abort()
  await iterator.return?.()
})
