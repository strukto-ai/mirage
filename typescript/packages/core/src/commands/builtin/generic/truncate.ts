import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { eisdir, enoent, enotdir, isEnotdir, isFsError } from '../../../errors/fs.ts'
import { classify } from '../../../errors/classify.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { shellQuoteAlways } from '../../../utils/quote.ts'
import { isDir } from '../../../utils/stat_view.ts'
import { UsageError } from '../../errors.ts'
import { usageHint } from '../../spec/usage.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { absentDestError } from '../utils/paths.ts'
import { endsAtDot } from '../../../utils/path.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'

export type SizeMode =
  | 'absolute'
  | 'extend'
  | 'reduce'
  | 'at_most'
  | 'at_least'
  | 'round_down'
  | 'round_up'

const MODES: ReadonlySet<string> = new Set<SizeMode>([
  'absolute',
  'extend',
  'reduce',
  'at_most',
  'at_least',
  'round_down',
  'round_up',
])

/**
 * What `-s` asks of a file's size, as mirage-rs read it: how the number
 * applies to the current size, and the number typed, its suffix applied. A
 * bigint, since an off_t passes 2**53. Mirrors Python's `Size`.
 */
export interface Size {
  readonly mode: SizeMode
  readonly number: bigint
}

/** The length `size` asks for, given a file's current one. Mirrors Python's `resolve_size`. */
export function resolveSize(size: Size, current: bigint): bigint {
  const number = size.number
  if (size.mode === 'extend') return current + number
  if (size.mode === 'reduce') return current > number ? current - number : 0n
  if (size.mode === 'at_most') return current < number ? current : number
  if (size.mode === 'at_least') return current > number ? current : number
  if (size.mode === 'round_down') return current - (current % number)
  if (size.mode === 'round_up') return ((current + number - 1n) / number) * number
  return number
}

// GNU opens the operand with O_CREAT before it looks at anything, so a name
// typed with a slash is settled by the open: `missing/` and `reg/` are both
// "Is a directory" and nothing is created. The size is read first here only
// because a relative spec needs it, so for a slashed operand a stat that
// misses is not the verdict; the truncate op answers, as the open would.

export interface TruncateFlags {
  readonly size: Size
  readonly noCreate: boolean
}

/**
 * truncate's options, `-s` read by mirage-rs before any operand is resolved:
 * the flags, or truncate's refusal. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): TruncateFlags | IOResult {
  const fl = new FlagView(bag, specOf('truncate'))
  let values
  try {
    values = scan('truncate', fl.texts('size'))
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const size = values.size
  if (
    size === null ||
    typeof size !== 'object' ||
    Array.isArray(size) ||
    typeof size.mode !== 'string' ||
    !MODES.has(size.mode) ||
    typeof size.size !== 'string'
  ) {
    throw new Error(`truncate: mirage-rs read -s as ${JSON.stringify(size)}`)
  }
  return {
    size: { mode: size.mode as SizeMode, number: BigInt(size.size) },
    noCreate: fl.asBool('no_create'),
  }
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
  if (paths.length === 0)
    throw new UsageError(`truncate: missing file operand\n${usageHint('truncate')}`, 1)
  const errors: string[] = []
  for (const path of paths) {
    try {
      const line = await truncateOne(path, flags, stat, truncate)
      if (line !== null) errors.push(line)
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
// ENOTDIR. A length that cannot take (a pipe has none) is the ftruncate
// step's EINVAL, which GNU words with the size it asked for, and that line
// is returned. Mirrors Python's _truncate_one.
async function truncateOne(
  path: PathSpec,
  flags: TruncateFlags,
  stat: (path: PathSpec) => Promise<FileStat>,
  truncate: (path: PathSpec, length: number, noCreate: boolean) => Promise<void>,
): Promise<string | null> {
  let current = 0n
  let directory = false
  try {
    const st = await stat(path)
    current = BigInt(st.size ?? 0)
    directory = isDir(st)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    if (isEnotdir(err) && (flags.noCreate || !path.rawPath.endsWith('/'))) throw err
    const why = await absentDestError(stat, path)
    if (why === 'ENOTDIR') throw enotdir(path)
    if (flags.noCreate) return null
    if (why !== null) throw enoent(path)
    current = 0n
  }
  const slashed = path.rawPath.endsWith('/') && !endsAtDot(path.rawPath)
  if (directory || (slashed && !flags.noCreate)) throw eisdir(path)
  const size = resolveSize(flags.size, current)
  try {
    await truncate(path, Number(size), flags.noCreate)
  } catch (err) {
    if (classify(err) !== 'EINVAL') throw err
    const label = shellQuoteAlways(path.rawPath === '' ? path.virtual : path.rawPath)
    return `truncate: failed to truncate ${label} at ${size.toString()} bytes: ${posixPhrase('EINVAL')}\n`
  }
  return null
}
