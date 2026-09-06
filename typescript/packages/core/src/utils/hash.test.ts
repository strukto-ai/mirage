import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { md5Hex, md5HexAsync } from './hash.ts'

it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 16383, 16384, 16385, 1000000])(
  'preserves MD5 across block/padding boundaries (%i bytes)',
  async (size) => {
    const allocation = Uint8Array.from({ length: size + 7 }, (_, i) => (i * 31) % 256)
    const data = allocation.subarray(7)
    const expected = createHash('md5').update(data).digest('hex')
    expect(md5Hex(data)).toBe(expected)
    expect(await md5HexAsync(data)).toBe(expected)
  },
)
