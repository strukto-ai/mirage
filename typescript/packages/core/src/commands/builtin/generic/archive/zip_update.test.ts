import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readZipEntries } from '../unzip.ts'
import { encodeRecord, readArchive, updateArchive } from './zip_update.ts'
import { ZipUpdateError } from './errors.ts'
import type { ZipArchive, ZipRecord } from './types.ts'
import { ByteSlice, ByteSpool } from '../../../../io/spool.ts'
import { materialize } from '../../../../io/types.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../../../integ/fixtures/zip/update.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>
const data = (key: string): Uint8Array => new Uint8Array(Buffer.from(fixture[key] ?? '', 'base64'))
const dec = new TextDecoder()

async function read(raw: Uint8Array): Promise<ZipArchive> {
  const spool = new ByteSpool()
  await spool.append(raw)
  return readArchive(spool)
}

const update = (
  original: ZipArchive | null,
  additions: readonly ZipRecord[],
): Promise<Uint8Array> => materialize(updateArchive(original, additions))

it.each([
  ['original', ''],
  ['original', 'self-extracting stub'],
  ['streamed', ''],
])('preserves opaque members and metadata: %s %s', async (kind, prefix) => {
  const original = await read(new Uint8Array(Buffer.concat([Buffer.from(prefix), data(kind)])))
  const result = await update(original, (await read(data('additions'))).records)
  const after = await read(result)
  expect(dec.decode(await materialize(after.prefix.stream()))).toBe(prefix)
  expect(after.comment).toEqual(original.comment)
  expect(after.records.map((r) => r.name)).toEqual([
    ...original.records.map((r) => r.name),
    ...['new.xml', 'target.xml', 'café.txt'].filter(
      (name) => !original.records.some((r) => r.name === name),
    ),
  ])
  for (const entry of original.records) {
    if (['target.xml', 'café.txt'].includes(entry.name)) continue
    const kept = after.records.find((r) => r.name === entry.name)
    expect(await materialize(kept?.local.stream() ?? null)).toEqual(
      await materialize(entry.local.stream()),
    )
    expect(kept?.central.subarray(0, 42)).toEqual(entry.central.subarray(0, 42))
    expect(kept?.central.subarray(46)).toEqual(entry.central.subarray(46))
  }
  const entries = readZipEntries(result).entries
  for (const [name, value] of [
    ['target.xml', 'updated'],
    ['new.xml', 'new'],
    ['café.txt', 'unicode'],
  ]) {
    expect(dec.decode(await entries.find((r) => r.name === name)?.content())).toBe(value)
  }
})

it.each([
  [4, 1],
  [8, 0xffff],
  [10, 0xffff],
  [12, 0xffffffff],
  [16, 0xffffffff],
])('refuses unsupported end records: %s', async (offset, value) => {
  const raw = data('streamed')
  const view = new DataView(raw.buffer)
  if (offset < 12) view.setUint16(raw.length - 22 + offset, value, true)
  else view.setUint32(raw.length - 22 + offset, value, true)
  await expect(read(raw)).rejects.toThrow(ZipUpdateError)
})

it.each(['truncated', 'bad-local', 'bad-central', 'bad-offset'])(
  'refuses corrupt archives: %s',
  async (kind) => {
    let raw = data('streamed')
    const central = Buffer.from(raw).indexOf('PK\x01\x02', 0, 'binary')
    if (kind === 'truncated') raw = raw.slice(0, -10)
    else if (kind === 'bad-local') raw[0] = 0
    else if (kind === 'bad-central') raw[central] = 0
    else new DataView(raw.buffer).setUint32(central + 42, central, true)
    await expect(read(raw)).rejects.toThrow(ZipUpdateError)
  },
)

it('preserves leading BOM in member names', async () => {
  const original = await read(data('bom'))
  const additions = await read(data('additions'))
  const result = await read(await update(original, additions.records))
  const bytesOf = (records: ZipRecord[], name: string): Promise<Uint8Array> =>
    materialize(records.find((r) => r.name === name)?.local.stream() ?? null)
  expect(await bytesOf(result.records, '\ufefftarget.xml')).toEqual(
    await bytesOf(original.records, '\ufefftarget.xml'),
  )
  expect(result.records.filter((r) => r.name === 'target.xml')).toHaveLength(1)
  expect(await bytesOf(result.records, 'target.xml')).toEqual(
    await bytesOf(additions.records, 'target.xml'),
  )
})

it('writes ZIP64 past the ZIP32 member count', async () => {
  const [head, central] = encodeRecord(new Uint8Array([0x61]), 0, 0, 0, 0, 0o100644 << 16)
  const record = { name: 'a', local: new ByteSlice(new ByteSpool(), 0, 0), central, head }
  const result = await update(null, Array<ZipRecord>(0x10000).fill(record))
  const view = new DataView(result.buffer, result.byteOffset, result.length)
  const zip64 = result.length - 22 - 76
  expect(view.getUint32(zip64, true)).toBe(0x06064b50)
  expect(view.getBigUint64(zip64 + 32, true)).toBe(0x10000n)
  expect(view.getBigUint64(zip64 + 48, true)).toBe(BigInt(0x10000 * head.length))
  expect(view.getUint16(result.length - 22 + 10, true)).toBe(0xffff)
})

it.each(['name', 'flags', 'method', 'crc', 'size', 'local-extra', 'central-extra', 'local-zip64'])(
  'refuses inconsistent or ZIP64 local records: %s',
  async (kind) => {
    const raw = data(kind === 'local-zip64' ? 'local-zip64' : 'original')
    const view = new DataView(raw.buffer)
    const central = Buffer.from(raw).indexOf('PK\x01\x02', 0, 'binary')
    const offsets: Record<string, number> = { name: 30, flags: 6, method: 8, crc: 14 }
    const offset = offsets[kind]
    if (offset !== undefined) view.setUint8(offset, view.getUint8(offset) ^ 1)
    else if (kind === 'size') view.setUint32(22, 0xffffffff, true)
    else if (kind === 'local-extra') view.setUint16(38, 1, true)
    else if (kind === 'central-extra') view.setUint16(central + 54, 1, true)
    await expect(read(raw)).rejects.toThrow(ZipUpdateError)
  },
)
