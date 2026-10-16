import { afterEach, expect, it } from 'vitest'
import { ByteSpool, setSpoolFactory } from './spool.ts'
import { materialize } from './types.ts'
import { concat } from '../utils/bytes.ts'

afterEach(() => {
  setSpoolFactory(null)
})

it.each([0, 13, 2000000])('spills, replays and reads windows with budget %s', async (limit) => {
  let closed = 0
  let stored: Uint8Array = new Uint8Array()
  setSpoolFactory(() =>
    Promise.resolve({
      append: (part) => {
        stored = concat([stored, part])
        return Promise.resolve()
      },
      read: (offset, size) => Promise.resolve(stored.slice(offset, offset + size)),
      close: () => {
        closed++
        return Promise.resolve()
      },
    }),
  )
  const expected = Uint8Array.from({ length: 358400 }, (_, i) => i % 256)
  const spool = new ByteSpool(limit)
  try {
    for (let start = 0; start < expected.length; start += 777)
      await spool.append(expected.slice(start, start + 777))
    expect(spool.size).toBe(expected.length)
    expect(await spool.read(262141, 11)).toEqual(expected.slice(262141, 262152))
    expect(await spool.read(0, 9)).toEqual(expected.slice(0, 9))
    expect(await materialize(spool.stream())).toEqual(expected)
    expect(await materialize(spool.stream(70000, 5000))).toEqual(expected.slice(70000, 75000))
    expect(await spool.read(expected.length, 8)).toEqual(new Uint8Array())
  } finally {
    await spool.close()
  }
  await expect(spool.read(0, 1)).rejects.toThrow('closed')
  await spool.close()
  expect(closed).toBe(limit < expected.length ? 1 : 0)
})

it('closes its source when spilling fails', async () => {
  let closed = false
  setSpoolFactory(() => Promise.reject(new Error('scratch full')))
  async function* source() {
    await Promise.resolve()
    try {
      yield new Uint8Array([1])
      throw new Error('must not pull again')
    } finally {
      closed = true
    }
  }
  const spool = new ByteSpool(0)
  try {
    await expect(spool.fill(source())).rejects.toThrow('scratch full')
  } finally {
    await spool.close()
  }
  expect(closed).toBe(true)
})
