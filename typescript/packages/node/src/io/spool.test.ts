import { expect, it } from 'vitest'
import { ByteSpool } from '@struktoai/mirage-core/io/spool'
import { materialize } from '@struktoai/mirage-core/io/types'
import './spool.ts'

it('replays spilled bytes through SDK and fetch upload bodies', async () => {
  const spool = new ByteSpool(0)
  const expected = new Uint8Array(70000).map((_, i) => i % 251)
  try {
    await spool.fill(expected)
    const body = await spool.body('sdk')
    if (body instanceof Blob) throw new Error('expected Node readable')
    expect(await materialize(body)).toEqual(expected)
    const blob = await spool.body('fetch')
    if (!(blob instanceof Blob)) throw new Error('expected file-backed Blob')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected)
    expect(await spool.read(16380, 17)).toEqual(expected.slice(16380, 16397))
  } finally {
    await spool.close()
  }
  await expect(spool.read(0, 1)).rejects.toThrow('closed')
})
