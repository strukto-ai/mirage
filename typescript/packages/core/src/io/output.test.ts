import { describe, expect, it } from 'vitest'
import { concat } from './cachable_iterator.ts'
import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'
import { OutputPipe } from './output.ts'
import { CAPACITY } from './pipe.ts'
import type { OutputEvent } from './types.ts'

const enc = new TextEncoder()

describe('OutputPipe', () => {
  it.each([false, true])('drain waits for consumption or reader close (%s)', async (close) => {
    const pipe = new OutputPipe()
    await pipe.write('stdout', enc.encode('payload'))
    pipe.end()
    const events = pipe.events()
    expect((await events.next()).value).toEqual({ stream: 'stdout', data: enc.encode('payload') })
    let done = false
    const drained = pipe.drain().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    if (close) pipe.closeReader()
    else expect((await events.next()).done).toBe(true)
    await drained
    await events.return(undefined)
  })

  it('bounds large output and preserves stream order', async () => {
    const pipe = new OutputPipe()
    const data = enc.encode('a\0'.repeat(CAPACITY))
    const writing = (async () => {
      await pipe.write('stdout', data)
      await pipe.write('stderr', enc.encode('warning'))
      await pipe.write('stdout', enc.encode('tail'))
      pipe.end()
    })()
    await expect.poll(() => pipe.bufferedBytes).toBe(CAPACITY)
    const events: OutputEvent[] = []
    for await (const event of pipe.events()) {
      expect(event.data.byteLength).toBeLessThanOrEqual(CHUNK_SIZE)
      expect(pipe.bufferedBytes).toBeLessThanOrEqual(CAPACITY)
      events.push(event)
    }
    await writing
    expect(events.slice(0, -2).every((event) => event.stream === 'stdout')).toBe(true)
    expect(concat(events.slice(0, -2).map((event) => event.data))).toEqual(data)
    expect(events.slice(-2)).toEqual([
      { stream: 'stderr', data: enc.encode('warning') },
      { stream: 'stdout', data: enc.encode('tail') },
    ])
  })

  it('close before reading unblocks a saturated writer', async () => {
    const pipe = new OutputPipe()
    await pipe.write('stdout', new Uint8Array(CAPACITY))
    const writing = pipe.write('stderr', enc.encode('pending'))
    const refused = expect(writing).rejects.toBeInstanceOf(PipeClosed)
    await Promise.resolve()
    pipe.closeReader()
    pipe.closeReader()
    await refused
    expect(pipe.bufferedBytes).toBe(0)
    expect((await pipe.events().next()).done).toBe(true)
    await expect(pipe.write('stdout', enc.encode('late'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it('close releases a pending reader', async () => {
    const pipe = new OutputPipe()
    const events = pipe.events()
    const pending = events.next()
    pipe.closeReader()
    expect((await pending).done).toBe(true)
    await events.return(undefined)
  })

  it('delivers accepted stream events before a late failure', async () => {
    const pipe = new OutputPipe()
    await pipe.write('stdout', enc.encode('prefix'))
    await pipe.write('stderr', enc.encode('warning'))
    pipe.end(new Error('late failure'))
    const events = pipe.events()
    const first = await events.next()
    const second = await events.next()
    if (first.done || second.done) throw new Error('missing accepted output')
    expect(first.value.stream).toBe('stdout')
    expect(second.value.stream).toBe('stderr')
    await expect(events.next()).rejects.toThrow('late failure')
  })

  it('ending the writer preserves accepted tags and rejects a pending write', async () => {
    const pipe = new OutputPipe()
    await pipe.write('stdout', new Uint8Array(CAPACITY))
    const writing = pipe.write('stderr', enc.encode('pending'))
    const refused = expect(writing).rejects.toBeInstanceOf(PipeClosed)
    await Promise.resolve()
    pipe.end()
    await refused
    const events: OutputEvent[] = []
    for await (const event of pipe.events()) events.push(event)
    expect(events.reduce((size, event) => size + event.data.byteLength, 0)).toBe(CAPACITY)
    expect(events.every((event) => event.stream === 'stdout')).toBe(true)
  })

  it('rejects a second reader without closing the first', async () => {
    const pipe = new OutputPipe()
    await pipe.write('stdout', enc.encode('first'))
    const events = pipe.events()
    expect((await events.next()).done).toBe(false)
    await expect(pipe.events().next()).rejects.toThrow('already has a reader')
    expect(pipe.closedReader).toBe(false)
    await pipe.write('stderr', enc.encode('last'))
    pipe.end()
    const remaining: OutputEvent[] = []
    for await (const event of events) remaining.push(event)
    expect(remaining).toEqual([{ stream: 'stderr', data: enc.encode('last') }])
  })

  it('abandoning events unblocks the writer', async () => {
    const pipe = new OutputPipe()
    const writing = pipe.write('stdout', new Uint8Array(CAPACITY * 3))
    const refused = expect(writing).rejects.toBeInstanceOf(PipeClosed)
    for await (const event of pipe.events()) {
      expect(event.data.byteLength).toBe(CHUNK_SIZE)
      break
    }
    await refused
    expect(pipe.closedReader).toBe(true)
  })

  it('keeps concurrent writes in acceptance order', async () => {
    const pipe = new OutputPipe()
    const first = pipe.write('stdout', new Uint8Array(CAPACITY * 2))
    await expect.poll(() => pipe.bufferedBytes).toBe(CAPACITY)
    const second = pipe.write('stderr', enc.encode('warning'))
    const finishing = Promise.all([first, second]).then(() => {
      pipe.end()
    })
    const events: OutputEvent[] = []
    for await (const event of pipe.events()) events.push(event)
    await finishing
    expect(events.slice(0, -1).every((event) => event.stream === 'stdout')).toBe(true)
    expect(events.slice(0, -1).reduce((size, event) => size + event.data.byteLength, 0)).toBe(
      CAPACITY * 2,
    )
    expect(events.at(-1)).toEqual({ stream: 'stderr', data: enc.encode('warning') })
  })
})
