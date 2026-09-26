import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { md5Hex, md5HexAsync } from './hash.ts'

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
