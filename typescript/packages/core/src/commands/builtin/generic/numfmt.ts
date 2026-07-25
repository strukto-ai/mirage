import { IOResult, materialize } from '../../../io/types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })
const SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'] as const
// SI spells kilo lowercase; every larger unit and all of IEC stay uppercase.
const SI_DISPLAY: readonly string[] = ['', 'k', ...SUFFIXES.slice(2)]

function parseNumber(value: string, fromMode: string): number {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z]*)$/.exec(value)
  if (match === null) throw new Error(`numfmt: invalid number: '${value}'`)
  const number = Number(match[1])
  const suffix = (match[2] ?? '').replace(/i?B$/, '').replace(/i$/, '').toUpperCase()
  if (suffix === '' || fromMode === 'none') return number
  const exponent = SUFFIXES.indexOf(suffix as (typeof SUFFIXES)[number])
  if (exponent < 0) throw new Error(`numfmt: invalid suffix in input: '${value}'`)
  return number * (fromMode === 'si' ? 1000 : 1024) ** exponent
}

// Round away from zero at `places` decimals. Snapping to 15 significant digits
// first drops the sub-ulp binary noise a bare ceil can trip over, without the
// blind spot of a fixed absolute epsilon: subtracting 1e-9 before ceil also
// erases a genuine offset smaller than that, so 1000.00000001 collapses to
// 1.0k, while GNU and the Decimal path in Python both keep it at 1.1k.
function roundAwayFromZero(value: number, places: number): number {
  const factor = 10 ** places
  const scaled = Number((Math.abs(value) * factor).toPrecision(15))
  return Math.sign(value) * (Math.ceil(scaled) / factor)
}

// printf("%.*f") rounds half to even, which is why an unscaled 2.5 prints 2.
function toFixedHalfEven(value: number, places: number): string {
  const factor = 10 ** places
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  let unit: number
  if (diff > 0.5 + 1e-9) unit = floor + 1
  else if (diff < 0.5 - 1e-9) unit = floor
  else unit = floor % 2 === 0 ? floor : floor + 1
  return (unit / factor).toFixed(places)
}

// GNU rounds away from zero, keeping one decimal only while the scaled value
// is below 10. That rounding can push a value back over the base
// (999.4 -> 1000 -> 1.0k), so the unit is re-checked afterwards.
function formatNumber(value: number, toMode: string, grouping: boolean): string {
  if (toMode === 'none') {
    return grouping ? value.toLocaleString('en-US', { maximumFractionDigits: 20 }) : String(value)
  }
  const base = toMode === 'si' ? 1000 : 1024
  const display = toMode === 'si' ? SI_DISPLAY : SUFFIXES
  let number = value
  let power = 0
  while (Math.abs(number) >= base && power < display.length - 1) {
    number /= base
    power += 1
  }
  number = roundAwayFromZero(number, Math.abs(number) < 10 ? 1 : 0)
  if (Math.abs(number) >= base && power < display.length - 1) {
    number /= base
    power += 1
  }
  const places = power > 0 && Math.abs(number) < 10 ? 1 : 0
  const body = toFixedHalfEven(number, places)
  const grouped = grouping
    ? Number(body).toLocaleString('en-US', { minimumFractionDigits: places })
    : body
  const suffix = `${display[power] ?? ''}${toMode === 'iec-i' && power > 0 ? 'i' : ''}`
  return grouped + suffix
}

function convertField(
  value: string,
  toMode: string,
  fromMode: string,
  suffix: string,
  grouping: boolean,
): string {
  const stripped = suffix !== '' && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value
  return formatNumber(parseNumber(stripped, fromMode), toMode, grouping) + suffix
}

// GNU numfmt converts only --field (1 by default) and copies the remaining
// fields and their separating whitespace through untouched.
function convertLine(
  line: string,
  toMode: string,
  fromMode: string,
  suffix: string,
  grouping: boolean,
): string {
  const match = /^(\s*)(\S+)([\s\S]*)$/.exec(line)
  if (match === null) return line
  const [, lead = '', field = '', rest = ''] = match
  return lead + convertField(field, toMode, fromMode, suffix, grouping) + rest
}

function splitLinesNoEnds(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

export async function numfmtGeneric(
  texts: readonly string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const toMode = typeof opts.flags.to === 'string' ? opts.flags.to : 'none'
  const fromMode = typeof opts.flags.from === 'string' ? opts.flags.from : 'none'
  const suffix = typeof opts.flags.suffix === 'string' ? opts.flags.suffix : ''
  const grouping = opts.flags.grouping === true
  let output: string[]
  if (texts.length > 0) {
    output = texts.map((value) => convertField(value, toMode, fromMode, suffix, grouping))
  } else {
    const data = DEC.decode(await materialize(resolveSource(opts.stdin)))
    output = splitLinesNoEnds(data).map((line) =>
      convertLine(line, toMode, fromMode, suffix, grouping),
    )
  }
  if (output.length === 0) return [new Uint8Array(0), new IOResult()]
  return [ENC.encode(output.join('\n') + '\n'), new IOResult()]
}
