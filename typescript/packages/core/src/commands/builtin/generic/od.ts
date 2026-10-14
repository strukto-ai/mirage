import { IOResult, type ByteSource } from '../../../io/types.ts'
import { chunks } from '../../../io/cooperative.ts'
import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { PathSpec, ReadRangeFn } from '../../../types.ts'
import { concat } from '../../../utils/bytes.ts'
import { UsageError } from '../../errors.ts'
import { OD_OVERFLOW_UNITS, OD_SIZE_UNITS, UINTMAX, XSTRTOUMAX_PATTERN } from '../constants.ts'
import { parseBase0 } from '../utils/size_suffix.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'

const ENC = new TextEncoder()

export function parseCount(value: string, flag: string): number {
  const match = XSTRTOUMAX_PATTERN.exec(value)
  if (match === null) throw new UsageError(`od: invalid ${flag} argument '${value}'`, 1)
  const number = match[1] ?? ''
  const suffix = match[2] ?? ''
  const multiplier = OD_SIZE_UNITS[suffix] ?? OD_OVERFLOW_UNITS[suffix]
  if (suffix !== '' && multiplier === undefined) {
    throw new UsageError(`od: invalid suffix in ${flag} argument '${value}'`, 1)
  }
  // The too-large check compares in BigInt: 2**64 - 1 is valid and 2**64
  // is not, a boundary doubles cannot hold.
  const magnitude = parseBase0(number) * BigInt(multiplier ?? 1)
  if (magnitude > UINTMAX) throw new UsageError(`od: ${flag} argument '${value}' too large`, 1)
  return Number(magnitude)
}

function address(offset: number, radix: string): string {
  if (radix === 'n') return ''
  const base = radix === 'd' ? 10 : radix === 'x' ? 16 : 8
  return offset.toString(base).padStart(7, '0')
}

function character(byte: number): string {
  const escapes: Readonly<Record<number, string>> = {
    0: '\\0',
    7: '\\a',
    8: '\\b',
    9: '\\t',
    10: '\\n',
    11: '\\v',
    12: '\\f',
    13: '\\r',
  }
  if (escapes[byte] !== undefined) return escapes[byte]
  if (byte >= 32 && byte < 127) return String.fromCharCode(byte)
  return byte.toString(8).padStart(3, '0')
}

function formatValues(data: Uint8Array, typeSpec: string): string {
  const kind = typeSpec.slice(0, 1)
  const size = Number.parseInt(typeSpec.slice(1) || (kind === 'f' ? '8' : '2'), 10)
  if (kind === 'a' || kind === 'c')
    return [...data].map((byte) => character(byte).padStart(3, ' ')).join(' ')
  const values: string[] = []
  for (let offset = 0; offset < data.length; offset += size) {
    const bytes = new Uint8Array(size)
    bytes.set(data.slice(offset, offset + size))
    const view = new DataView(bytes.buffer)
    if (kind === 'f') {
      values.push((size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true)).toPrecision(6))
      continue
    }
    let value = 0n
    for (let index = size - 1; index >= 0; index -= 1)
      value = value * 256n + BigInt(bytes[index] ?? 0)
    if (kind === 'd' && (bytes[size - 1] ?? 0) >= 128) value -= 1n << BigInt(size * 8)
    if (kind === 'x') values.push(value.toString(16).padStart(size * 2, '0'))
    else if (kind === 'o') values.push(value.toString(8).padStart(Math.ceil((size * 8) / 3), '0'))
    else values.push(value.toString())
  }
  return values.join(' ')
}

const SKIP_PAST_END = 'od: cannot skip past end of combined input\n'

/** One operand's bytes past `skip` and up to `left`, the stream closed once
 * `left` are in; returns them and the skip left over. Mirrors Python's
 * _taken. */
async function taken(
  source: AsyncIterable<Uint8Array>,
  skip: number,
  left: number | null,
): Promise<[Uint8Array[], number]> {
  const kept: Uint8Array[] = []
  let toSkip = skip
  let toKeep = left
  for await (const piece of chunks(source)) {
    let chunk = piece
    if (toSkip > 0) {
      const dropped = Math.min(toSkip, chunk.byteLength)
      chunk = chunk.subarray(dropped)
      toSkip -= dropped
    }
    if (toKeep !== null) {
      chunk = chunk.subarray(0, toKeep)
      toKeep -= chunk.byteLength
    }
    if (chunk.byteLength > 0) kept.push(chunk)
    if (toKeep === 0) break
  }
  return [kept, toSkip]
}

/**
 * The operands as od's one input, past `skip` and within `limit`. As GNU od: a
 * regular file wholly inside the skip is passed over unread, and the rest of
 * the skip is one ranged read where the mount has one, which also stops at
 * `limit`. An operand that cannot be opened is reported and passed over; one
 * that fails to read (a directory) is reported, ends any skip, and counts as
 * opened. Once `limit` bytes are in, no later operand is opened. Returns the
 * bytes, the error lines, whether any operand opened, and the skip left
 * unspent. Mirrors Python's _combined.
 */
async function combined(
  paths: readonly PathSpec[],
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readRange: ReadRangeFn | null,
  sizeOf: ((p: PathSpec) => Promise<number | null>) | null,
  skip: number,
  limit: number | null,
): Promise<[Uint8Array, string, boolean, number]> {
  const kept: Uint8Array[] = []
  let err = ''
  let opened = false
  let toSkip = skip
  let left = limit
  for (const p of paths) {
    if (left === 0 && opened) break
    try {
      const size =
        sizeOf !== null && readRange !== null && (toSkip > 0 || left !== null) && !isStdin(p)
          ? await sizeOf(p)
          : null
      let part: Uint8Array[]
      if (size !== null && readRange !== null) {
        opened = true
        if (toSkip >= size) {
          toSkip -= size
          continue
        }
        const want = left === null ? size - toSkip : Math.min(left, size - toSkip)
        part = [await readRange(p, toSkip, want)]
        toSkip = 0
      } else {
        ;[part, toSkip] = await taken(read(p), toSkip, left)
        opened = true
      }
      kept.push(...part)
      if (left !== null) for (const chunk of part) left -= chunk.byteLength
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine('od', p, e)
      if (isEisdir(e)) {
        opened = true
        toSkip = 0
      }
    }
  }
  return [concat(kept), err, opened, toSkip]
}

/**
 * Dump the operands, GNU od semantics. od defines multiple FILE operands as
 * one concatenated input, so skip and limit offsets apply across the whole
 * run, not per file. `readRange` serves -j and -N without reading the bytes
 * they pass. Mirrors Python's od_generic.
 */
export async function odGeneric(
  paths: readonly PathSpec[],
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  addressRadix: string,
  skip: number,
  limit: number | null,
  formats: readonly string[],
  readRange: ReadRangeFn | null = null,
  sizeOf: ((p: PathSpec) => Promise<number | null>) | null = null,
): Promise<[ByteSource | null, IOResult]> {
  let data: Uint8Array
  let err = ''
  let opened = true
  let unspent: number
  if (paths.length > 0) {
    ;[data, err, opened, unspent] = await combined(
      paths,
      stdinStream(read, stdin, true),
      readRange,
      sizeOf,
      skip,
      limit,
    )
  } else {
    let kept: Uint8Array[]
    ;[kept, unspent] = await taken(resolveSource(stdin), skip, limit)
    data = concat(kept)
  }
  if (unspent > 0) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(err + SKIP_PAST_END) })]
  }
  const io = new IOResult({
    exitCode: err === '' ? 0 : 1,
    stderr: err === '' ? null : encodeText(err),
  })
  if (!opened) return [null, io]
  const typeSpecs = formats.length > 0 ? formats : ['o2']
  const lines: string[] = []
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.slice(offset, offset + 16)
    for (let index = 0; index < typeSpecs.length; index += 1) {
      const location = index === 0 ? address(skip + offset, addressRadix) : ''
      // GNU prints every value as " %s", so a suppressed address column
      // still leaves one leading space per line.
      const prefix = location !== '' ? `${location} ` : addressRadix === 'n' ? ' ' : ' '.repeat(8)
      lines.push(prefix + formatValues(block, typeSpecs[index] ?? 'o2'))
    }
  }
  const finalAddress = address(skip + data.length, addressRadix)
  if (finalAddress !== '') lines.push(finalAddress)
  if (lines.length === 0) return [new Uint8Array(0), io]
  return [ENC.encode(lines.join('\n') + '\n'), io]
}
