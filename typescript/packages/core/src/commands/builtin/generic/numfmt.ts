import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })
const SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'] as const
// SI spells kilo lowercase; every larger unit and all of IEC stay uppercase.
const SI_DISPLAY: readonly string[] = ['', 'k', ...SUFFIXES.slice(2)]
// Only kilo has a lowercase spelling; every larger unit is uppercase-only.
const UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  K: 1,
  k: 1,
  M: 2,
  G: 3,
  T: 4,
  P: 5,
  E: 6,
  Z: 7,
  Y: 8,
  R: 9,
  Q: 10,
})
// GNU accepts no leading '+' and no bare trailing '.', and it reads no
// exponent: `1e3` is a number followed by the unknown suffix 'e3'.
const NUMBER_RE = /^(-?(?:[0-9]*\.[0-9]+|[0-9]+))([\s\S]*)$/

// A value carried exactly, as digits / 10**scale, so that `--to=none` can
// print every digit of `1Y` rather than the `1e+24` a double renders.
interface Parsed {
  digits: bigint
  scale: number
  decimals: number
}

// GNU's two shapes of suffix complaint, exit 2 either way. An unusable
// first character quotes only the whole field; a usable unit followed by
// junk quotes the field and then the junk (pinned against coreutils 9.7).
function suffixError(value: string, junk: string): UsageError {
  if (junk === '') return new UsageError(`numfmt: invalid suffix in input: '${value}'`, 2)
  return new UsageError(`numfmt: invalid suffix in input '${value}': '${junk}'`, 2)
}

// Each --from mode spells the same units differently: si and iec take the
// bare letter, iec-i requires the trailing 'i', and auto takes either and
// lets the 'i' pick base 1024. Nothing may follow (pinned against coreutils
// 9.7), which is why `1KiB` is refused everywhere -- it used to be read as
// a kilobyte in both languages.
function scaleOf(value: string, suffix: string, fromMode: string): [number, number] {
  const exponent = UNIT_EXPONENTS[suffix[0] ?? '']
  if (exponent === undefined) throw suffixError(value, '')
  const tail = suffix.slice(1)
  if (fromMode === 'iec-i') {
    if (tail === '') {
      throw new UsageError(`numfmt: missing 'i' suffix in input: '${value}' (e.g Ki/Mi/Gi)`, 2)
    }
    if (!tail.startsWith('i')) throw suffixError(value, tail)
    if (tail.length > 1) throw suffixError(value, tail.slice(1))
    return [1024, exponent]
  }
  if (fromMode === 'auto') {
    const base = tail.startsWith('i') ? 1024 : 1000
    const rest = base === 1024 ? tail.slice(1) : tail
    if (rest !== '') throw suffixError(value, rest)
    return [base, exponent]
  }
  if (tail !== '') throw suffixError(value, tail)
  return [fromMode === 'si' ? 1000 : 1024, exponent]
}

// GNU prints an unscaled value back at the precision it was typed with
// (`1.000` stays `1.000`) and a scaled one as a whole number rounded away
// from zero (`1.0005K` is `1001`), so the decimal count travels with the
// value. A unit that is spelled correctly but unusable because no --from
// was given is reported as such, which is why the unit letter is checked
// before the mode is. Deliberate divergence: GNU calls a second decimal
// point an invalid suffix in some spellings and an invalid number in
// others (`1.5.5` against `1..5`); mirage calls every trailing decimal
// point an invalid number.
function parseNumber(value: string, fromMode: string): Parsed {
  const match = NUMBER_RE.exec(value)
  const head = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  if (match === null || (rest.startsWith('.') && !head.includes('.'))) {
    throw new UsageError(`numfmt: invalid number: '${value}'`, 2)
  }
  const dot = head.indexOf('.')
  const fraction = dot < 0 ? '' : head.slice(dot + 1)
  const digits = BigInt(dot < 0 ? head : head.slice(0, dot) + fraction)
  if (rest === '') return { digits, scale: fraction.length, decimals: fraction.length }
  if (UNIT_EXPONENTS[rest[0] ?? ''] === undefined) throw suffixError(value, '')
  if (fromMode === 'none') {
    throw new UsageError(`numfmt: rejecting suffix in input: '${value}' (consider using --from)`, 2)
  }
  const [base, exponent] = scaleOf(value, rest, fromMode)
  return {
    digits: digits * BigInt(base) ** BigInt(exponent),
    scale: fraction.length,
    decimals: 0,
  }
}

// Round digits/10**scale away from zero at `places` decimals, returning the
// result scaled by 10**places. BigInt division truncates toward zero, so a
// non-zero remainder is what pushes the magnitude up.
function roundAway(digits: bigint, scale: number, places: number): bigint {
  if (scale <= places) return digits * 10n ** BigInt(places - scale)
  const divisor = 10n ** BigInt(scale - places)
  const quotient = digits / divisor
  if (digits % divisor === 0n) return quotient
  return digits < 0n ? quotient - 1n : quotient + 1n
}

function fixed(scaled: bigint, places: number, grouping: boolean): string {
  const negative = scaled < 0n
  const text = (negative ? -scaled : scaled).toString().padStart(places + 1, '0')
  const whole = text.slice(0, text.length - places)
  const grouped = grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole
  const fraction = places > 0 ? `.${text.slice(text.length - places)}` : ''
  return (negative ? '-' : '') + grouped + fraction
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
// (999.4 -> 1000 -> 1.0k), so the unit is re-checked afterwards. --to=none
// instead keeps the precision the value was parsed with and rounds away
// from zero there, always in fixed notation -- `1Y` is a twenty-five digit
// number, never `1e+24`. Deliberate divergence: GNU reads the input into a
// long double first, so a value it cannot hold exactly rounds up on the way
// out (`1.10` prints as `1.11` while `1.20` and `1.30` do not); mirage
// keeps the value exact, as it already does for printf.
function formatNumber(parsed: Parsed, toMode: string, grouping: boolean): string {
  if (toMode === 'none') {
    return fixed(roundAway(parsed.digits, parsed.scale, parsed.decimals), parsed.decimals, grouping)
  }
  const base = toMode === 'si' ? 1000 : 1024
  const display = toMode === 'si' ? SI_DISPLAY : SUFFIXES
  let number = Number(parsed.digits) / 10 ** parsed.scale
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
  const fl = new FlagView(opts.flags, specOf('numfmt'))
  const toMode = fl.asStr('to') ?? 'none'
  const fromMode = fl.asStr('from') ?? 'none'
  const suffix = fl.asStr('suffix') ?? ''
  const grouping = fl.asBool('grouping')
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
