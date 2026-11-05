import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { contentOid } from './commit.ts'

it.each([0, 1, 65, 131_073])('preserves Git and LFS content IDs for %i bytes', (size) => {
  const allocation = Uint8Array.from({ length: size + 7 }, (_, i) => i % 256)
  const data = allocation.subarray(7)
  expect(contentOid(data, 'regular')).toBe(
    createHash('sha1')
      .update(`blob ${String(size)}\0`)
      .update(data)
      .digest('hex'),
  )
  for (const mode of ['lfs', 'xet']) {
    expect(contentOid(data, mode)).toBe(createHash('sha256').update(data).digest('hex'))
  }
})
