import { expect, it } from 'vitest'
import { getCompressionCodec } from '@struktoai/mirage-core/utils/compress'
import { materialize } from '@struktoai/mirage-core/io/types'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import './compression_codecs.ts'

it('round trips XZ across bounded input chunks', async () => {
  const codec = getCompressionCodec('xz')
  if (codec?.compressStream === undefined || codec.decompressStream === undefined)
    throw new Error('missing streaming codec')
  const data = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251)
  expect(await materialize(codec.decompressStream(codec.compressStream(chunks(data))))).toEqual(
    data,
  )
})

it('decodes bzip2 across chunk boundaries and rejects truncation', async () => {
  const codec = getCompressionCodec('bzip2')
  if (codec?.decompressStream === undefined) throw new Error('missing streaming codec')
  const data = Uint8Array.from(
    Buffer.from(
      'QlpoOTFBWSZTWcx3Y78ABdvBAAAQAkSgAFBmgE1UY2pBlSD9SDKkG1SDhdyRThQkMx3Y78A=',
      'base64',
    ),
  )
  async function* input(): AsyncGenerator<Uint8Array> {
    for (let start = 0; start < data.length; start += 7) {
      await Promise.resolve()
      yield data.slice(start, start + 7)
    }
  }
  expect(new TextDecoder().decode(await materialize(codec.decompressStream(input())))).toBe(
    'hello\n'.repeat(1000),
  )
  await expect(materialize(codec.decompressStream(chunks(data.slice(0, -4))))).rejects.toThrow()
})
