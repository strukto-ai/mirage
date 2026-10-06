import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { eisdir, enoent, enotdir, isEnotdir, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isDir } from '../../../utils/stat_view.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { sizeSuffixes } from '../utils/size_suffix.ts'
import { absentDestStrerror } from '../utils/paths.ts'
import { encodeText } from '../../../shell/bytes.ts'

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
  // whitespace and mode character, sign included (`<abc` says 'abc'),
  // escaped the way its quote() escapes a word.
  const shown = quoteText(remainder)
  if (!DIGITS.test(numeric)) throw new UsageError(`truncate: Invalid number: '${shown}'`, 1)
  // off_t is signed, so the bound is 2**63 - 1 upward but 2**63 downward
  // (`-s -8E` reduces to zero while `-s 8E` is too large). BigInt keeps the
  // boundary exact where doubles round 2**63 - 1 up to 2**63.
  const magnitude = BigInt(numeric) * BigInt(suffix === undefined ? 1 : (UNITS[suffix] ?? 1))
  if (magnitude > OFF_T_MAX + (sign === '-' ? 1n : 0n)) {
    throw new UsageError(
      `truncate: Invalid number: '${shown}': Value too large for defined data type`,
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

// GNU opens the operand with O_CREAT before it looks at anything, so a name
// typed with a slash is settled by the open: `missing/` and `reg/` are both
// "Is a directory" and nothing is created. The size is read first here only
// because a relative spec needs it, so for a slashed operand a stat that
// misses is not the verdict; the truncate op answers, as the open would.

export interface TruncateFlags {
  readonly size: string
  readonly noCreate: boolean
}

// Parse the truncate flag bag once. GNU reads the size while it reads the
// options, so a spec it refuses is refused here, before any operand is
// touched or named. Mirrors Python's parse_flags.
export function parseFlags(bag: Record<string, FlagValue>): TruncateFlags {
  const fl = new FlagView(bag, specOf('truncate'))
  const size = fl.asStr('size')
  if (size === undefined) {
    throw new UsageError(
      `truncate: you must specify either '--size' or '--reference'${TRY_HELP}`,
      1,
    )
  }
  parseSize(size, 0)
  return { size, noCreate: fl.asBool('no_create') }
}

// Set each operand's length, GNU `truncate -s`. Every operand is tried,
// and one GNU cannot open is reported in its words and the rest still go
// (exit 1): `cannot open 'x' for writing` for any open failure, a
// directory's EISDIR included. Mirrors Python's truncate.
export async function truncateGeneric(
  paths: readonly PathSpec[],
  flags: TruncateFlags,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number, noCreate: boolean) => Promise<void>,
): Promise<[ByteSource | null, IOResult]> {
  if (paths.length === 0) throw new UsageError(`truncate: missing file operand${TRY_HELP}`, 1)
  const errors: string[] = []
  for (const path of paths) {
    try {
      await truncateOne(path, flags, stat, truncate)
    } catch (e) {
      if (!isFsError(e)) throw e
      errors.push(fsErrorLine('truncate', path, e))
    }
  }
  const err = errors.join('')
  return [
    null,
    new IOResult({ exitCode: err === '' ? 0 : 1, stderr: err === '' ? null : encodeText(err) }),
  ]
}

// One operand, in the order GNU's open settles it. GNU opens the name
// before it looks at anything, with O_CREAT unless -c: an absent file is
// made (-c leaves it, silently), but only in a directory that exists, and
// a plain file in the chain is ENOTDIR either way. The size is read first
// here only because a relative spec needs it, so a stat that misses is not
// the verdict: the chain is, walked the way cp walks a destination's, since
// a backend's write would make a key under any parent at all. A directory,
// and a name typed with a slash in a directory that exists, is the open's
// EISDIR, settled here so a backend with no truncate op answers in GNU's
// words too: `missing/` and `reg/` are both `Is a directory` and nothing is
// made, while under -c `reg/` goes to the truncate op, whose lookup is
// ENOTDIR. Mirrors Python's _truncate_one.
async function truncateOne(
  path: PathSpec,
  flags: TruncateFlags,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number, noCreate: boolean) => Promise<void>,
): Promise<void> {
  let current = 0
  let directory = false
  try {
    const st = await stat(path)
    current = st.size ?? 0
    directory = isDir(st)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    if (isEnotdir(err) && (flags.noCreate || !path.rawPath.endsWith('/'))) throw err
    const why = await absentDestStrerror(stat, path)
    if (why === 'Not a directory') throw enotdir(path)
    if (flags.noCreate) return
    if (why !== null) throw enoent(path)
    current = 0
  }
  if (directory || (path.rawPath.endsWith('/') && !flags.noCreate)) throw eisdir(path)
  await truncate(path, parseSize(flags.size, current), flags.noCreate)
}
