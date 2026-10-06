import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Sha1, md5Hex, md5HexAsync, sha1Hex, sha1LengthTrailer } from './hash.ts'

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
    // md5HexAsync hands the event loop back every 64 generator slices (~1 MiB)
    // so a large hash cannot stall a FUSE mount's loop. The sizes span that
    // boundary in both directions, because the digest has to survive being
    // interrupted mid-stream -- the yield sits between block rounds, and a
    // state variable dropped there would only show above 1 MiB.
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
  'Sha1 fed in uneven chunks agrees with sha1Hex (%i bytes)',
  async (size) => {
    const data = seeded(size, size + 1)
    const hasher = new Sha1()
    for (const chunk of splitAt(data, [1, 63, 65, 16_387])) hasher.update(chunk)
    expect(hasher.digest()).toBe(await sha1Hex(data))
  },
)

// Hashing 512 MiB in a unit test is too slow, so the length trailer is
// checked directly where the bit length crosses 32 bits.
it.each([2 ** 29 - 1, 2 ** 29, 2 ** 32 + 3])(
  'sha1LengthTrailer is the big-endian 64-bit bit length (%i bytes)',
  (byteLength) => {
    const expected = new Uint8Array(8)
    new DataView(expected.buffer).setBigUint64(0, BigInt(byteLength) * 8n, false)
    expect(sha1LengthTrailer(byteLength)).toEqual(expected)
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
