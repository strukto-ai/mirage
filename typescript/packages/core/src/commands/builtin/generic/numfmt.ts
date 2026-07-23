import { IOResult, materialize } from '../../../io/types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })
const SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'] as const

function parseNumber(value: string, fromMode: string): number {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z]*)$/.exec(value)
  if (match === null) throw new Error(`numfmt: invalid number: '${value}'`)
  const number = Number(match[1])
  const suffix = (match[2] ?? '').replace(/i?B$/, '').replace(/i$/, '')
  if (suffix === '' || fromMode === 'none') return number
  const exponent = SUFFIXES.indexOf(suffix as (typeof SUFFIXES)[number])
  if (exponent < 0) throw new Error(`numfmt: invalid suffix in input: '${value}'`)
  return number * (fromMode === 'si' ? 1000 : 1024) ** exponent
}

function formatNumber(value: number, toMode: string, grouping: boolean): string {
  let number = value
  let exponent = 0
  if (toMode !== 'none') {
    const base = toMode === 'si' ? 1000 : 1024
    while (Math.abs(number) >= base && exponent < SUFFIXES.length - 1) {
      number /= base
      exponent += 1
    }
  }
  const rounded = Number.isInteger(number) ? number.toFixed(0) : number.toFixed(1)
  const body = grouping ? Number(rounded).toLocaleString('en-US') : rounded
  const suffix = `${SUFFIXES[exponent] ?? ''}${toMode === 'iec-i' && exponent > 0 ? 'i' : ''}`
  return body + suffix
}

export async function numfmtGeneric(texts: readonly string[], opts: CommandOpts): Promise<CommandFnResult> {
  let values = [...texts]
  if (values.length === 0) {
    values = DEC.decode(await materialize(resolveSource(opts.stdin))).trim().split(/\s+/)
  }
  const toMode = typeof opts.flags.to === 'string' ? opts.flags.to : 'none'
  const fromMode = typeof opts.flags.from === 'string' ? opts.flags.from : 'none'
  const suffix = typeof opts.flags.suffix === 'string' ? opts.flags.suffix : ''
  const output = values.map((value) =>
    formatNumber(
      parseNumber(suffix !== '' && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value, fromMode),
      toMode,
      opts.flags.grouping === true,
    ) + suffix,
  )
  return [ENC.encode(output.join('\n') + '\n'), new IOResult()]
}
