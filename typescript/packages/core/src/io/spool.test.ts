import { afterEach, expect, it } from 'vitest'
import { ByteSlice, ByteSpool, setSpoolFactory } from './spool.ts'
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
    expect(await spool.read(16383, 40000)).toEqual(expected.slice(16383, 56383))
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

function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

it('answers concurrent reads of a spilled spool each from its own window', async () => {
  let stored: Uint8Array = new Uint8Array()
  setSpoolFactory(() =>
    Promise.resolve({
      append: async (part) => {
        await later()
        stored = concat([stored, part])
      },
      read: async (offset, size) => {
        await later()
        return stored.slice(offset, offset + size)
      },
      close: () => Promise.resolve(),
    }),
  )
  const expected = Uint8Array.from({ length: 600_001 }, (_, i) => (i * 7) % 256)
  const spool = new ByteSpool(0)
  try {
    await spool.append(expected)
    await spool.append(expected.slice(0, 1))
    const windows: [number, number][] = [
      [600_000, 2],
      [1, 1],
      [300_000, 4095],
      [550_000, 100],
      [10, 20],
    ]
    const whole = concat([expected, expected.slice(0, 1)])
    const reads = await Promise.all(windows.map(([offset, size]) => spool.read(offset, size)))
    expect(reads).toEqual(windows.map(([offset, size]) => whole.slice(offset, offset + size)))
    expect(stored.byteLength).toBe(whole.byteLength)
  } finally {
    await spool.close()
  }
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

it('fails every call after an append it lost', async () => {
  let fail = false
  setSpoolFactory(() =>
    Promise.resolve({
      append: () => (fail ? Promise.reject(new Error('scratch full')) : Promise.resolve()),
      read: (_offset, size) => Promise.resolve(new Uint8Array(size)),
      close: () => Promise.resolve(),
    }),
  )
  const spool = new ByteSpool(0)
  try {
    await spool.append(new Uint8Array(300000))
    fail = true
    await expect(spool.append(new Uint8Array(300000))).rejects.toThrow('scratch full')
    fail = false
    await expect(spool.append(new Uint8Array(1))).rejects.toMatchObject({ code: 'EIO' })
    await expect(spool.read(0, 4)).rejects.toMatchObject({ code: 'EIO' })
  } finally {
    await spool.close()
  }
})

it('sizes and slices a byte slice as its window', async () => {
  const spool = new ByteSpool()
  try {
    await spool.append(new TextEncoder().encode('0123456789'))
    const window = new ByteSlice(spool, 2, 6)
    const head = window.subarray(0, 2)
    const tail = window.subarray(4)
    expect(window.byteLength).toBe(6)
    expect([head.offset, head.byteLength]).toEqual([2, 2])
    expect([tail.offset, tail.byteLength]).toEqual([6, 2])
    expect(window.subarray(10).byteLength).toBe(0)
    expect(new TextDecoder().decode(await materialize(tail.stream()))).toBe('67')
  } finally {
    await spool.close()
  }
})
