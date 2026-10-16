import { concat } from '../../../../utils/bytes.ts'
import { ZipUpdateError } from './errors.ts'
import type { ByteSpool } from '../../../../io/spool.ts'
import { ByteSlice } from '../../../../io/spool.ts'
import type { ZipArchive, ZipRecord, SpoolZipArchive, SpoolZipRecord } from './types.ts'

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

/** Read opaque records; updates need no decompressor or password. */
export function readArchive(data: Uint8Array): ZipArchive {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (offset: number): number => view.getUint16(offset, true)
  const u32 = (offset: number): number => view.getUint32(offset, true)
  let end = data.length - 22
  for (; end >= Math.max(0, data.length - 65557); end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === data.length) break
  }
  if (end < Math.max(0, data.length - 65557)) throw new ZipUpdateError('missing end record')
  const count = u16(end + 10)
  const size = u32(end + 12)
  const offset = u32(end + 16)
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count)
    throw new ZipUpdateError('split archive')
  // The writer emits single-disk ZIP32. Refuse other formats before writing.
  if (count === 0xffff || Math.max(size, offset) === 0xffffffff)
    throw new ZipUpdateError('ZIP64 archive')
  const shift = end - size - offset
  const start = end - size
  if (shift < 0 || start < 0) throw new ZipUpdateError('invalid directory offset')
  let pos = start
  const entries: { name: string; central: Uint8Array; local: number; csize: number }[] = []
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50)
      throw new ZipUpdateError('invalid directory entry')
    const flags = u16(pos + 8)
    const csize = u32(pos + 20)
    const usize = u32(pos + 24)
    const nameLen = u16(pos + 28)
    const extraLen = u16(pos + 30)
    const noteLen = u16(pos + 32)
    const local = u32(pos + 42)
    const next = pos + 46 + nameLen + extraLen + noteLen
    if (u16(pos + 34) || Math.max(csize, usize, local) === 0xffffffff || next > end)
      throw new ZipUpdateError('unsupported or truncated entry')
    const rawName = data.subarray(pos + 46, pos + 46 + nameLen)
    checkExtra(data.subarray(pos + 46 + nameLen, next - noteLen))
    let name: string
    try {
      name =
        flags & 0x800
          ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName)
          : Array.from(rawName, (b) =>
              b < 128 ? String.fromCharCode(b) : CP437.charAt(b - 128),
            ).join('')
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      throw new ZipUpdateError('invalid entry name')
    }
    entries.push({ name, central: data.subarray(pos, next), local: local + shift, csize })
    pos = next
  }
  if (pos !== end) throw new ZipUpdateError('invalid directory size')
  const offsets = entries.map((e) => e.local).sort((a, b) => a - b)
  if (new Set(offsets).size !== offsets.length)
    throw new ZipUpdateError('overlapping local records')
  const limits = new Map(offsets.map((offset, i) => [offset, offsets[i + 1] ?? start]))
  const records = entries.map((entry) => {
    const limit = limits.get(entry.local) ?? start
    if (entry.local < 0 || entry.local + 30 > limit || u32(entry.local) !== 0x04034b50)
      throw new ZipUpdateError('invalid local record')
    if (entry.local + 30 + u16(entry.local + 26) + u16(entry.local + 28) + entry.csize > limit)
      throw new ZipUpdateError('truncated local record')
    const local = entry.local
    const nameLen = u16(local + 26)
    const extraLen = u16(local + 28)
    const central = new DataView(
      entry.central.buffer,
      entry.central.byteOffset,
      entry.central.length,
    )
    if (
      nameLen !== central.getUint16(28, true) ||
      !data
        .subarray(local + 30, local + 30 + nameLen)
        .every((b, i) => b === entry.central[46 + i]) ||
      u32(local + 6) !== central.getUint32(8, true)
    )
      throw new ZipUpdateError('inconsistent local record')
    if (u32(local + 18) === 0xffffffff || u32(local + 22) === 0xffffffff)
      throw new ZipUpdateError('ZIP64 local record')
    if (
      !(central.getUint16(8, true) & 8) &&
      !data.subarray(local + 14, local + 26).every((b, i) => b === entry.central[16 + i])
    )
      throw new ZipUpdateError('inconsistent local sizes or CRC')
    checkExtra(data.subarray(local + 30 + nameLen, local + 30 + nameLen + extraLen))
    return { name: entry.name, central: entry.central, local: data.subarray(entry.local, limit) }
  })
  return {
    records,
    prefix: data.subarray(0, offsets[0] ?? start),
    comment: data.subarray(end + 22),
  }
}

/** Replace names in place, append new ones, and copy untouched bytes. */
export function updateArchive(
  original: ZipArchive | null,
  additions: readonly ZipRecord[],
): Uint8Array {
  original ??= { records: [], prefix: new Uint8Array(), comment: new Uint8Array() }
  const replacements = new Map(additions.map((e) => [e.name, e]))
  const oldNames = new Set(original.records.map((e) => e.name))
  const records = [
    ...original.records.map((e) => replacements.get(e.name) ?? e),
    ...additions.filter((e) => !oldNames.has(e.name)),
  ]
  const localParts = [original.prefix]
  const centralParts: Uint8Array[] = []
  let offset = original.prefix.length
  for (const entry of records) {
    if (offset >= 0xffffffff) throw new ZipUpdateError('ZIP64 required')
    const central = new Uint8Array(entry.central)
    new DataView(central.buffer).setUint32(42, offset, true)
    centralParts.push(central)
    localParts.push(entry.local)
    offset += entry.local.length
  }
  const directory = concat(centralParts)
  if (records.length >= 0xffff || Math.max(offset, directory.length) >= 0xffffffff)
    throw new ZipUpdateError('ZIP64 required')
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, records.length, true)
  view.setUint16(10, records.length, true)
  view.setUint32(12, directory.length, true)
  view.setUint32(16, offset, true)
  view.setUint16(20, original.comment.length, true)
  return concat([...localParts, directory, end, original.comment])
}

export async function readSpooledArchive(data: ByteSpool): Promise<SpoolZipArchive> {
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
  const records: SpoolZipRecord[] = []
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

export async function* updateSpooledArchive(
  original: SpoolZipArchive | null,
  additions: readonly SpoolZipRecord[],
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
    if (offset >= 0xffffffff) throw new ZipUpdateError('ZIP64 required')
    const central = entry.central.slice()
    new DataView(central.buffer).setUint32(42, offset, true)
    centralParts.push(central)
    offset += entry.local.size
  }
  const directorySize = centralParts.reduce((n, c) => n + c.length, 0)
  if (records.length >= 0xffff || Math.max(offset, directorySize) >= 0xffffffff)
    throw new ZipUpdateError('ZIP64 required')
  if (original !== null) yield* original.prefix.stream()
  for (const entry of records) yield* entry.local.stream()
  yield* centralParts
  const comment = original?.comment ?? new Uint8Array()
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, records.length, true)
  view.setUint16(10, records.length, true)
  view.setUint32(12, directorySize, true)
  view.setUint32(16, offset, true)
  view.setUint16(20, comment.length, true)
  yield end
  yield comment
}
