import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Digest, md5Hex, md5HexAsync, sha1Hex } from './hash.ts'

it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 16383, 16384, 16385, 1000000])(
  'preserves MD5 across block/padding boundaries (%i bytes)',
  (size) => {
    const allocation = Uint8Array.from({ length: size + 7 }, (_, i) => (i * 31) % 256)
    const data = allocation.subarray(7)
    const expected = createHash('md5').update(data).digest('hex')
    expect(md5Hex(data)).toBe(expected)
  },
)

it.each([0, 1, 63, 64, 65, 16384, 1024 * 1024, 4 * 1024 * 1024])(
  'md5HexAsync agrees with md5Hex across yield boundaries (%i bytes)',
  async (size) => {
    // md5HexAsync hands the event loop back every MiB so a large hash cannot
    // stall a FUSE mount's loop. The sizes span that boundary in both
    // directions, because the digest has to survive being interrupted
    // mid-stream: a state variable dropped there would only show above 1 MiB.
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256)
    expect(await md5HexAsync(data)).toBe(md5Hex(data))
  },
)

function seeded(length: number, seed: number): Uint8Array {
  let state = seed >>> 0
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state >>> 24
  })
}

// Splits that never land on a 64-byte boundary, so every update carries a
// partial block into the next one.
function splitAt(data: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  let at = 0
  for (const size of sizes) {
    if (at >= data.byteLength) break
    out.push(data.subarray(at, Math.min(at + size, data.byteLength)))
    at += size
  }
  if (at < data.byteLength) out.push(data.subarray(at))
  return out
}

it.each([0, 55, 56, 64, 200_000])(
  'SHA-1 fed in uneven chunks agrees with sha1Hex (%i bytes)',
  async (size) => {
    const data = seeded(size, size + 1)
    const hasher = new Digest('sha1')
    for (const chunk of splitAt(data, [1, 63, 65, 16_387])) hasher.update(chunk)
    expect(hasher.digest()).toBe(await sha1Hex(data))
  },
)

it.each([0, 55, 56, 64, 200_000])(
  'MD5 fed in uneven chunks agrees with node (%i bytes)',
  (size) => {
    const data = seeded(size, size + 1)
    const hasher = new Digest('md5')
    for (const chunk of splitAt(data, [1, 63, 65, 16_387])) hasher.update(chunk)
    expect(hasher.digest()).toBe(createHash('md5').update(data).digest('hex'))
  },
)

it.each([
  ['no crypto', undefined],
  ['no subtle', {}],
])('sha1Hex falls back and yields with %s', async (_name, cryptoValue) => {
  vi.stubGlobal('crypto', cryptoValue)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(await sha1Hex(new Uint8Array(0))).toBe(createHash('sha1').digest('hex'))
    const data = seeded(1024 * 1024 + 24, 42).subarray(7)
    const expected = createHash('sha1').update(data).digest('hex')
    let yielded = false
    timer = setTimeout(() => {
      yielded = true
    }, 0)
    expect(await sha1Hex(data)).toBe(expected)
    expect(yielded).toBe(true)
  } finally {
    clearTimeout(timer)
    vi.unstubAllGlobals()
  }
})

it.each(['md5', 'sha1', 'sha256'] as const)(
  'keeps concurrent %s digests independent across input windows',
  (algorithm) => {
    const data = seeded(1024 * 1024 + 65, 42).subarray(7)
    const first = new Digest(algorithm)
    const second = new Digest(algorithm)
    try {
      first.update(data.subarray(0, 63))
      second.update(data.subarray(63))
      first.update(data.subarray(63))
      expect(first.digest()).toBe(createHash(algorithm).update(data).digest('hex'))
      expect(second.digest()).toBe(createHash(algorithm).update(data.subarray(63)).digest('hex'))
    } finally {
      first.close()
      second.close()
    }
  },
)

it('releases a digest after completion or abandonment', () => {
  const completed = new Digest('md5')
  expect(completed.digest()).toBe(createHash('md5').digest('hex'))
  expect(() => {
    completed.update(new Uint8Array([1]))
  }).toThrow()
  completed.close()
  const abandoned = new Digest('sha1')
  abandoned.update(new Uint8Array([1, 2]))
  abandoned.close()
  abandoned.close()
  expect(() => abandoned.digest()).toThrow()
  expect(md5Hex(new Uint8Array())).toBe(createHash('md5').digest('hex'))
})
