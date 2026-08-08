import { IOResult } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { sizeSuffixes } from '../utils/size_suffix.ts'

// GNU truncate's letter set differs from split's and od's: lowercase
// g/k/m/t are accepted, b is not (pinned against coreutils 9.7).
const UNITS = sizeSuffixes('EGKMPQRTYZgkmt')
const OFF_T_MAX = 2n ** 63n - 1n
const WS = /^[ \t\n\v\f\r]+/
const TRY_HELP = "\nTry 'truncate --help' for more information."

// GNU reads the -s operand as [ws][mode][ws][sign]digits[suffix]: C-locale
// whitespace is skipped before and after the mode character (` < 4` caps at
// 4), while the digits must follow the sign immediately, so `1x`, `+ 4`,
// `++4` and `1_0` are all `Invalid number` rather than a silently truncated
// read (pinned against coreutils 9.7). parseInt would take the numeric
// prefix of `1x` and hand back NaN for `abc`, and NaN reaches the backend
// truncate op as a length, where `new Uint8Array(NaN)` empties the file.
const DIGITS = /^[0-9]+$/

function parseSize(value: string, current: number): number {
  const stripped = value.replace(WS, '')
  const first = stripped.slice(0, 1)
  const operation = ['<', '>', '/', '%'].includes(first) ? first : ''
  const remainder = operation === '' ? stripped : stripped.slice(1).replace(WS, '')
  const signChar = remainder.slice(0, 1)
  const sign = signChar === '+' || signChar === '-' ? signChar : ''
  if (sign !== '' && operation !== '') {
    // A sign after <, >, / or % is a second relative modifier, refused
    // before the number is read (`<+4` is not an invalid number).
    throw new UsageError(`truncate: multiple relative modifiers specified${TRY_HELP}`, 1)
  }
  const raw = sign === '' ? remainder : remainder.slice(1)
  const suffix = Object.keys(UNITS)
    .sort((a, b) => b.length - a.length)
    .find((unit) => raw.endsWith(unit))
  const numeric = suffix === undefined ? raw : raw.slice(0, -suffix.length)
  // GNU quotes what xdectoimax saw: the remainder past the skipped
  // whitespace and mode character, sign included (`<abc` says 'abc').
  if (!DIGITS.test(numeric)) throw new UsageError(`truncate: Invalid number: '${remainder}'`, 1)
  // off_t is signed, so the bound is 2**63 - 1 upward but 2**63 downward
  // (`-s -8E` reduces to zero while `-s 8E` is too large). BigInt keeps the
  // boundary exact where doubles round 2**63 - 1 up to 2**63.
  const magnitude = BigInt(numeric) * BigInt(suffix === undefined ? 1 : (UNITS[suffix] ?? 1))
  if (magnitude > OFF_T_MAX + (sign === '-' ? 1n : 0n)) {
    throw new UsageError(
      `truncate: Invalid number: '${remainder}': Value too large for defined data type`,
      1,
    )
  }
  const number = Number(magnitude)
  if (number === 0 && (operation === '/' || operation === '%')) {
    throw new UsageError('truncate: division by zero', 1)
  }
  if (sign === '+') return current + number
  if (sign === '-') return Math.max(0, current - number)
  if (operation === '<') return Math.min(current, number)
  if (operation === '>') return Math.max(current, number)
  if (operation === '/') return current - (current % number)
  if (operation === '%') return Math.ceil(current / number) * number
  return number
}

export async function truncateGeneric(
  paths: readonly PathSpec[],
  size: string,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) throw new Error('truncate: missing file operand')
  for (const path of paths) {
    const current = (await stat(path)).size ?? 0
    await truncate(path, parseSize(size, current))
  }
  return [null, new IOResult()]
}
