import { IOResult, materialize } from '../../../io/types.ts'
import type { CommandFnResult } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { OD_COUNT_PATTERN, OD_OVERFLOW_UNITS, OD_SIZE_UNITS, UINTMAX } from '../constants.ts'

const ENC = new TextEncoder()

export function parseCount(value: string, flag: string): number {
  const match = OD_COUNT_PATTERN.exec(value)
  if (match === null) throw new UsageError(`od: invalid ${flag} argument '${value}'`, 1)
  const number = match[1] ?? ''
  const suffix = match[2] ?? ''
  const multiplier = OD_SIZE_UNITS[suffix] ?? OD_OVERFLOW_UNITS[suffix]
  if (suffix !== '' && multiplier === undefined) {
    throw new UsageError(`od: invalid suffix in ${flag} argument '${value}'`, 1)
  }
  const base =
    number.slice(0, 2).toLowerCase() === '0x'
      ? 16
      : number.startsWith('0') && number.length > 1
        ? 8
        : 10
  const digits = base === 16 ? number.slice(2) : number
  // The too-large check compares in BigInt: 2**64 - 1 is valid and 2**64
  // is not, a boundary doubles cannot hold.
  const magnitude =
    (base === 16 ? BigInt(`0x${digits}`) : base === 8 ? BigInt(`0o${digits}`) : BigInt(digits)) *
    BigInt(multiplier ?? 1)
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

export async function odGeneric(
  source: AsyncIterable<Uint8Array>,
  addressRadix: string,
  skip: number,
  limit: number | null,
  formats: readonly string[],
): Promise<CommandFnResult> {
  const raw = await materialize(source)
  const data = raw.slice(skip, limit === null ? undefined : skip + limit)
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
  if (lines.length === 0) return [new Uint8Array(0), new IOResult()]
  return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
}
