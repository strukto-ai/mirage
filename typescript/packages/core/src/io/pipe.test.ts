import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'
import { CAPACITY, BytePipe } from './pipe.ts'
import { concat } from './cachable_iterator.ts'

describe('BytePipe', () => {
  it.each([CHUNK_SIZE, CAPACITY, 262144])(
    'waits at capacity %i and preserves a large write in bounded chunks',
    async (capacity) => {
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
      for await (const part of pipe.stream()) {
        expect(part.byteLength).toBeLessThanOrEqual(CHUNK_SIZE)
        expect(pipe.bufferedBytes).toBeLessThanOrEqual(capacity)
        parts.push(part)
      }
      await writing
      expect(concat(parts)).toEqual(data)
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

  it('owns buffered bytes after accepting a mutable write', async () => {
    const pipe = new BytePipe()
    const data = new Uint8Array([1, 2, 3])
    await pipe.write(data)
    data.fill(0)
    pipe.end()
    expect((await pipe.stream().next()).value).toEqual(new Uint8Array([1, 2, 3]))
  })
})
