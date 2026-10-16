import { concat } from '../../../../utils/bytes.ts'
import { ZipUpdateError } from './errors.ts'
import type { ByteSpool } from '../../../../io/spool.ts'
import { ByteSlice } from '../../../../io/spool.ts'
import type { ZipArchive, ZipRecord } from './types.ts'

const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function checkExtra(data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let pos = 0
  while (pos < data.length) {
    if (pos + 4 > data.length) throw new ZipUpdateError('truncated extra field')
    const tag = view.getUint16(pos, true)
    pos += 4 + view.getUint16(pos + 2, true)
    if (tag === 1 || pos > data.length)
      throw new ZipUpdateError('unsupported or truncated extra field')
  }
}

/** Read opaque records; updates need no decompressor or password. ZIP64 and split archives are refused. */
export async function readArchive(data: ByteSpool): Promise<ZipArchive> {
  const tailStart = Math.max(0, data.size - 65557)
  const tail = await data.read(tailStart, data.size - tailStart)
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.length)
  let end = tail.length - 22
  for (; end >= 0; end--) {
    if (
      tailView.getUint32(end, true) === 0x06054b50 &&
      end + 22 + tailView.getUint16(end + 20, true) === tail.length
    )
      break
  }
  if (end < 0) throw new ZipUpdateError('missing end record')
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) ||
    tailView.getUint16(end + 6, true) ||
    tailView.getUint16(end + 8, true) !== count
  )
    throw new ZipUpdateError('split archive')
  if (count === 0xffff || Math.max(size, offset) === 0xffffffff)
    throw new ZipUpdateError('ZIP64 archive')
  const comment = tail.slice(end + 22)
  end += tailStart
  const shift = end - size - offset
  const start = end - size
  if (shift < 0 || start < 0) throw new ZipUpdateError('invalid directory offset')
  let pos = start
  const entries: { name: string; central: Uint8Array; local: number; csize: number }[] = []
  for (let i = 0; i < count; i++) {
    const header = await data.read(pos, 46)
    if (pos + 46 > end || header.length < 46) throw new ZipUpdateError('invalid directory entry')
    const view = new DataView(header.buffer, header.byteOffset, header.length)
    if (view.getUint32(0, true) !== 0x02014b50) throw new ZipUpdateError('invalid directory entry')
    const flags = view.getUint16(8, true)
    const csize = view.getUint32(20, true)
    const usize = view.getUint32(24, true)
    const nameLen = view.getUint16(28, true)
    const extraLen = view.getUint16(30, true)
    const noteLen = view.getUint16(32, true)
    const local = view.getUint32(42, true)
    const next = pos + 46 + nameLen + extraLen + noteLen
    if (view.getUint16(34, true) || Math.max(csize, usize, local) === 0xffffffff || next > end)
      throw new ZipUpdateError('unsupported or truncated entry')
    const extra = await data.read(pos + 46, nameLen + extraLen + noteLen)
    checkExtra(extra.subarray(nameLen, nameLen + extraLen))
    const rawName = extra.subarray(0, nameLen)
    let name: string
    try {
      name =
        flags & 0x800
          ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName)
          : Array.from(rawName, (b) =>
              b < 128 ? String.fromCharCode(b) : CP437.charAt(b - 128),
            ).join('')
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      throw new ZipUpdateError('invalid entry name')
    }
    entries.push({ name, central: concat([header, extra]), local: local + shift, csize })
    pos = next
  }
  if (pos !== end) throw new ZipUpdateError('invalid directory size')
  const offsets = entries.map((e) => e.local).sort((a, b) => a - b)
  if (new Set(offsets).size !== offsets.length)
    throw new ZipUpdateError('overlapping local records')
  const limits = new Map(offsets.map((o, i) => [o, offsets[i + 1] ?? start]))
  const records: ZipRecord[] = []
  for (const entry of entries) {
    const limit = limits.get(entry.local) ?? start
    if (entry.local < 0 || entry.local + 30 > limit)
      throw new ZipUpdateError('invalid local record')
    const header = await data.read(entry.local, 30)
    const view = new DataView(header.buffer, header.byteOffset, header.length)
    if (view.getUint32(0, true) !== 0x04034b50) throw new ZipUpdateError('invalid local record')
    const nameLen = view.getUint16(26, true)
    const extraLen = view.getUint16(28, true)
    if (entry.local + 30 + nameLen + extraLen + entry.csize > limit)
      throw new ZipUpdateError('truncated local record')
    const extra = await data.read(entry.local + 30, nameLen + extraLen)
    const central = new DataView(
      entry.central.buffer,
      entry.central.byteOffset,
      entry.central.length,
    )
    if (
      nameLen !== central.getUint16(28, true) ||
      !extra.subarray(0, nameLen).every((b, i) => b === entry.central[46 + i]) ||
      view.getUint32(6, true) !== central.getUint32(8, true)
    )
      throw new ZipUpdateError('inconsistent local record')
    if (view.getUint32(18, true) === 0xffffffff || view.getUint32(22, true) === 0xffffffff)
      throw new ZipUpdateError('ZIP64 local record')
    if (
      !(central.getUint16(8, true) & 8) &&
      !header.subarray(14, 26).every((b, i) => b === entry.central[16 + i])
    )
      throw new ZipUpdateError('inconsistent local sizes or CRC')
    checkExtra(extra.subarray(nameLen))
    records.push({
      name: entry.name,
      central: entry.central,
      local: new ByteSlice(data, entry.local, limit - entry.local),
    })
  }
  return { records, prefix: new ByteSlice(data, 0, offsets[0] ?? start), comment }
}

// The stamp every member carries: 1980-01-01 00:00, the DOS epoch and
// Python zipfile's default, which Info-ZIP lists as `80-Jan-01 00:00`.
// A zero date has month 0 and day 0, which is no date at all.
const DOS_EPOCH_DATE = (1 << 5) | 1
const ZIP32_MAX = 0xffffffff

/**
 * A new member's local header and central record, the record's offset left
 * for `updateArchive`; sizes past ZIP32 go in a ZIP64 field. Mirrors Python's
 * encode_record.
 */
export function encodeRecord(
  name: Uint8Array,
  method: number,
  crc: number,
  compressed: number,
  size: number,
  externalAttr: number,
): [Uint8Array, Uint8Array] {
  const large = Math.max(size, compressed) >= ZIP32_MAX
  const version = large ? 45 : 20
  const extra = new Uint8Array(large ? 20 : 0)
  if (large) {
    const view = new DataView(extra.buffer)
    view.setUint16(0, 1, true)
    view.setUint16(2, 16, true)
    view.setBigUint64(4, BigInt(size), true)
    view.setBigUint64(12, BigInt(compressed), true)
  }
  const head = new Uint8Array(30 + name.length + extra.length)
  const view = new DataView(head.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, version, true)
  view.setUint16(6, 0x800, true)
  view.setUint16(8, method, true)
  view.setUint16(12, DOS_EPOCH_DATE, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, large ? ZIP32_MAX : compressed, true)
  view.setUint32(22, large ? ZIP32_MAX : size, true)
  view.setUint16(26, name.length, true)
  view.setUint16(28, extra.length, true)
  head.set(name, 30)
  head.set(extra, 30 + name.length)
  const central = new Uint8Array(46 + name.length + extra.length)
  const record = new DataView(central.buffer)
  record.setUint32(0, 0x02014b50, true)
  // Unix in the high byte, so the mode bits below are read as such.
  record.setUint16(4, (3 << 8) | version, true)
  // Version through extra-field length have the same layout in both headers.
  central.set(head.subarray(4, 30), 6)
  record.setUint32(38, externalAttr, true)
  central.set(name, 46)
  central.set(extra, 46 + name.length)
  return [head, central]
}

/**
 * `central` pointing at its local record, through a ZIP64 field when the
 * offset is past ZIP32 (after the sizes one already holds). Mirrors Python's
 * _placed.
 */
function placed(central: Uint8Array, offset: number): Uint8Array {
  const record = central.slice()
  const view = new DataView(record.buffer)
  if (offset < ZIP32_MAX) {
    view.setUint32(42, offset, true)
    return record
  }
  view.setUint32(42, ZIP32_MAX, true)
  view.setUint16(6, 45, true)
  const start = 46 + view.getUint16(28, true)
  const extraLen = view.getUint16(30, true)
  const extra = record.subarray(start, start + extraLen)
  const tail = new Uint8Array(8)
  new DataView(tail.buffer).setBigUint64(0, BigInt(offset), true)
  let merged: Uint8Array
  if (extra[0] === 1 && extra[1] === 0) {
    const size = new DataView(extra.buffer, extra.byteOffset).getUint16(2, true)
    merged = concat([extra.subarray(0, 4 + size), tail, extra.subarray(4 + size)])
    new DataView(merged.buffer).setUint16(2, size + 8, true)
  } else {
    const field = new Uint8Array([1, 0, 8, 0])
    merged = concat([field, tail, extra])
  }
  view.setUint16(30, merged.length, true)
  return concat([record.subarray(0, start), merged, record.subarray(start + extraLen)])
}

/**
 * Replace names in place, append new ones, and copy untouched bytes, in
 * ZIP64 form where the archive outgrows ZIP32. Mirrors Python's
 * update_archive.
 */
export async function* updateArchive(
  original: ZipArchive | null,
  additions: readonly ZipRecord[],
): AsyncGenerator<Uint8Array> {
  const replacements = new Map(additions.map((e) => [e.name, e]))
  const oldNames = new Set(original?.records.map((e) => e.name))
  const records = [
    ...(original?.records.map((e) => replacements.get(e.name) ?? e) ?? []),
    ...additions.filter((e) => !oldNames.has(e.name)),
  ]
  let offset = original?.prefix.size ?? 0
  const centralParts: Uint8Array[] = []
  for (const entry of records) {
    centralParts.push(placed(entry.central, offset))
    offset += (entry.head?.length ?? 0) + entry.local.size
  }
  const directorySize = centralParts.reduce((n, c) => n + c.length, 0)
  if (original !== null) yield* original.prefix.stream()
  for (const entry of records) {
    if (entry.head !== undefined && entry.head.length > 0) yield entry.head
    yield* entry.local.stream()
  }
  yield* centralParts
  const count = records.length
  if (count >= 0xffff || Math.max(offset, directorySize) >= ZIP32_MAX) {
    const zip64 = new Uint8Array(76)
    const view = new DataView(zip64.buffer)
    view.setUint32(0, 0x06064b50, true)
    view.setBigUint64(4, 44n, true)
    view.setUint16(12, 45, true)
    view.setUint16(14, 45, true)
    view.setBigUint64(24, BigInt(count), true)
    view.setBigUint64(32, BigInt(count), true)
    view.setBigUint64(40, BigInt(directorySize), true)
    view.setBigUint64(48, BigInt(offset), true)
    view.setUint32(56, 0x07064b50, true)
    view.setBigUint64(64, BigInt(offset + directorySize), true)
    view.setUint32(72, 1, true)
    yield zip64
  }
  const comment = original?.comment ?? new Uint8Array()
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, Math.min(count, 0xffff), true)
  view.setUint16(10, Math.min(count, 0xffff), true)
  view.setUint32(12, Math.min(directorySize, ZIP32_MAX), true)
  view.setUint32(16, Math.min(offset, ZIP32_MAX), true)
  view.setUint16(20, comment.length, true)
  yield end
  yield comment
}
