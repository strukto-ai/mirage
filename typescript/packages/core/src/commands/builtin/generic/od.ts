import { IOResult, materialize } from '../../../io/types.ts'
import type { CommandFnResult } from '../../config.ts'

const ENC = new TextEncoder()

export function parseCount(value: string): number {
  const units: Readonly<Record<string, number>> = {
    b: 512,
    K: 1024,
    KB: 1000,
    M: 1024 ** 2,
    MB: 1000 ** 2,
  }
  const suffix = Object.keys(units)
    .sort((a, b) => b.length - a.length)
    .find((unit) => value.endsWith(unit))
  const numeric = suffix === undefined ? value : value.slice(0, -suffix.length)
  return Number.parseInt(numeric, 0) * (suffix === undefined ? 1 : (units[suffix] ?? 1))
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
      const prefix = location !== '' ? `${location} ` : addressRadix === 'n' ? '' : ' '.repeat(8)
      lines.push(prefix + formatValues(block, typeSpecs[index] ?? 'o2'))
    }
  }
  const finalAddress = address(skip + data.length, addressRadix)
  if (finalAddress !== '') lines.push(finalAddress)
  return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
}
