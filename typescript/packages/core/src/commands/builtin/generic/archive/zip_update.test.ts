import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readZipEntries } from '../unzip.ts'
import { readArchive, updateArchive } from './zip_update.ts'
import { ZipUpdateError } from './errors.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../../../integ/fixtures/zip/update.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>
const data = (key: string): Uint8Array => new Uint8Array(Buffer.from(fixture[key] ?? '', 'base64'))
const dec = new TextDecoder()

it.each([
  ['original', ''],
  ['original', 'self-extracting stub'],
  ['streamed', ''],
])('preserves opaque members and metadata: %s %s', async (kind, prefix) => {
  const original = readArchive(new Uint8Array(Buffer.concat([Buffer.from(prefix), data(kind)])))
  const result = updateArchive(original, readArchive(data('additions')).records)
  const after = readArchive(result)
  expect(dec.decode(after.prefix)).toBe(prefix)
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
    expect(kept?.local).toEqual(entry.local)
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
])('refuses unsupported end records: %s', (offset, value) => {
  const raw = data('streamed')
  const view = new DataView(raw.buffer)
  if (offset < 12) view.setUint16(raw.length - 22 + offset, value, true)
  else view.setUint32(raw.length - 22 + offset, value, true)
  expect(() => readArchive(raw)).toThrow(ZipUpdateError)
})

it.each(['truncated', 'bad-local', 'bad-central', 'bad-offset'])(
  'refuses corrupt archives: %s',
  (kind) => {
    let raw = data('streamed')
    const central = Buffer.from(raw).indexOf('PK\x01\x02', 0, 'binary')
    if (kind === 'truncated') raw = raw.slice(0, -10)
    else if (kind === 'bad-local') raw[0] = 0
    else if (kind === 'bad-central') raw[central] = 0
    else new DataView(raw.buffer).setUint32(central + 42, central, true)
    expect(() => readArchive(raw)).toThrow(ZipUpdateError)
  },
)
