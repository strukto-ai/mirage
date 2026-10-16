import { expect, it } from 'vitest'
import { RecordSpool } from './record_spool.ts'
import { materialize } from './types.ts'

it('replays empty, binary and large records backwards', async () => {
  const records = [
    new Uint8Array(),
    new Uint8Array([255, 0]),
    new Uint8Array(150000).fill(120),
    new TextEncoder().encode('tail'),
  ]
  const spool = new RecordSpool(1)
  try {
    for (const record of records) await spool.append(record)
    expect(spool.count).toBe(records.length)
    for (let i = records.length - 1; i >= 0; i--) {
      expect(await spool.read(i)).toEqual(records[i])
      expect(await materialize(spool.stream(i))).toEqual(records[i])
    }
    await expect(spool.read(4)).rejects.toThrow('out of range')
  } finally {
    await spool.close()
  }
})
