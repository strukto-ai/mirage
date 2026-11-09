import { describe, expect, it, vi } from 'vitest'
import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'
import { CAPACITY, BytePipe, SEALED } from './pipe.ts'
import { concat } from '../utils/bytes.ts'

describe('BytePipe', () => {
  it('wakes a polled reader on its own timer, never from the writer', async () => {
    vi.useFakeTimers()
    try {
      const pipe = new BytePipe(CAPACITY, true)
      const reader = pipe.stream()
      let got: Uint8Array | undefined
      const reading = reader.next().then((next) => {
        got = next.value as Uint8Array
      })
      await pipe.write(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(0)
      expect(got).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10)
      await reading
      expect(got).toEqual(new Uint8Array([1]))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a polled write on abort and leaves no timer', async () => {
    vi.useFakeTimers()
    try {
      const pipe = new BytePipe(CHUNK_SIZE, true)
      await pipe.write(new Uint8Array(CHUNK_SIZE))
      const abort = new AbortController()
      const writing = pipe.write(new Uint8Array(1), abort.signal)
      abort.abort()
      await expect(writing).rejects.toThrow()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(
    [CHUNK_SIZE, CAPACITY, 262144].flatMap((capacity) =>
      [false, true].map((joined) => [capacity, joined] as const),
    ),
  )(
    'waits at capacity %i (joined %s) and preserves a large write in bounded reads',
    async (capacity, joined) => {
      const read = joined ? capacity : CHUNK_SIZE
      const pipe = new BytePipe(capacity)
      const data = new Uint8Array(capacity * 3 + 7).fill(97)
      let finished = false
      const writing = pipe.write(data).then(() => {
        finished = true
        pipe.end()
      })
      expect(pipe.bufferedBytes).toBe(capacity)
      expect(finished).toBe(false)
      const parts: Uint8Array[] = []
      for await (const part of pipe.stream(joined)) {
        expect(part.byteLength).toBeLessThanOrEqual(read)
        expect(pipe.bufferedBytes).toBeLessThanOrEqual(capacity)
        parts.push(part)
      }
      await writing
      expect(concat(parts)).toEqual(data)
      expect(parts[0]?.byteLength).toBe(read)
    },
  )

  it.each(['reader', 'writer'])('closing the %s wakes a blocked writer', async (endpoint) => {
    const pipe = new BytePipe()
    await pipe.write(new Uint8Array(CAPACITY))
    const writing = pipe.write(new Uint8Array(1))
    const refused = expect(writing).rejects.toBeInstanceOf(PipeClosed)
    if (endpoint === 'reader') pipe.closeReader()
    else pipe.end()
    await refused
  })

  it('reader close wakes a parked reader', async () => {
    const pipe = new BytePipe()
    const reading = pipe.stream().next()
    pipe.closeReader()
    expect((await reading).done).toBe(true)
  })

  it('delivers buffered output before a late failure', async () => {
    const pipe = new BytePipe()
    await pipe.write(new TextEncoder().encode('prefix'))
    pipe.end(new Error('late failure'))
    const source = pipe.stream()
    const first = await source.next()
    if (first.done === true) throw new Error('missing buffered prefix')
    expect(new TextDecoder().decode(first.value)).toBe('prefix')
    await expect(source.next()).rejects.toThrow('late failure')
  })

  it('early reader exit releases a blocked writer', async () => {
    const pipe = new BytePipe()
    const writing = pipe.write(new Uint8Array(2 * CAPACITY))
    const refused = expect(writing).rejects.toBeInstanceOf(PipeClosed)
    const source = pipe.stream()
    const first = await source.next()
    if (first.done === true) throw new Error('missing buffered chunk')
    expect(first.value.byteLength).toBe(CHUNK_SIZE)
    await source.return(undefined)
    await refused
  })

  it('keeps a sealed write up to twice its capacity as written', async () => {
    for (const [size, kept] of [
      [CAPACITY + 1, true],
      [2 * CAPACITY + 1, false],
    ] as const) {
      const pipe = new BytePipe()
      const data = new Uint8Array(size)
      SEALED.add(data.buffer)
      const written = pipe.write(data).then(() => {
        pipe.end()
      })
      const parts: Uint8Array[] = []
      for await (const part of pipe.stream()) parts.push(part)
      await written
      expect(parts.map((part) => part.buffer === data.buffer)).toEqual(parts.map(() => kept))
    }
  })

  it('owns buffered bytes after accepting a mutable write', async () => {
    const pipe = new BytePipe()
    const data = new Uint8Array([1, 2, 3])
    await pipe.write(data)
    data.fill(0)
    pipe.end()
    expect((await pipe.stream().next()).value).toEqual(new Uint8Array([1, 2, 3]))
  })
})

it('cancels a blocked write without discarding accepted output', async () => {
  const pipe = new BytePipe(CHUNK_SIZE)
  await pipe.write(new Uint8Array(CHUNK_SIZE).fill(65))
  const abort = new AbortController()
  const blocked = pipe.write(new Uint8Array([66]), abort.signal)
  const refused = expect(blocked).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await refused
  pipe.end()
  const got: Uint8Array[] = []
  for await (const chunk of pipe.stream()) got.push(chunk)
  expect(concat(got)).toEqual(new Uint8Array(CHUNK_SIZE).fill(65))
})
