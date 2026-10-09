import { PATTERN_KEYS, mergePatternList } from '../grep_pattern.ts'
import { osErrorText } from '../rg_scan.ts'
import { dispatchStat } from '../utils/paths.ts'
import { isStdin, resolveSource } from '../utils/stream.ts'
import { specOf } from '../../spec/index.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { loadFailure } from '../../../core/jq/index.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { decodeText } from '../../../shell/bytes.ts'
import { FileType, type PathSpec } from '../../../types.ts'
import { eisdir, fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'

// The commands whose program files the executor reads before routing and
// lowers to their inline form. jq reads its -f file itself, after its option
// loop (OWN_OPTION_LOOP), so an option it refuses is reported first;
// FILE_KEYS still names its dest, so routing leaves the file out.
export const PROGRAM_FILE_COMMANDS = new Set(['grep', 'rg', 'zgrep', 'sed', 'awk'])

// ripgrep reads patterns from stdin once, and refuses both a second `-f -`
// and a `-` operand after it, exit 2 (14.1.1).
const RG_STDIN_REREAD = 'rg: error reading -f/--file from stdin: stdin has already been consumed\n'
const RG_STDIN_SEARCHED =
  'rg: error: attempted to read patterns from stdin while also searching stdin\n'

// The dest each command's spec gives its program file.
export const FILE_KEYS: Readonly<Record<string, string>> = {
  grep: 'file',
  rg: 'file',
  zgrep: 'f',
  sed: 'f',
  awk: 'f',
  jq: 'from_file',
}

/**
 * A program file the command cannot read, in its own words and code.
 *
 * sed could not open the file, exit 4. mawk quotes the name after `cannot
 * open`, and a file it opened and then failed to read, which is how a
 * directory fails, is a bare `read error`. jq could not open it, and calls a
 * directory one in words of its own. ripgrep appends the errno, with no space
 * after the colon for a failed read. zgrep copies each pattern file with cat,
 * so the line is cat's. grep names it as any operand. Every other code is 2.
 * Pinned on debian:stable-slim (grep 3.11, sed 4.9, mawk 1.3.4, jq 1.7.1,
 * ripgrep 14.1.1, gzip 1.13). Mirrors Python's program_file_refusal.
 */
export function programFileRefusal(name: string, path: PathSpec, err: unknown): [string, number] {
  const shown = path.rawPath !== '' ? path.rawPath : path.virtual
  const strerror = fsStrerror(err) ?? ''
  const readFailed = isEisdir(err)
  if (name === 'sed') return [`sed: couldn't open file ${shown}: ${strerror}\n`, 4]
  if (name === 'awk') {
    if (readFailed) return [`awk: read error (${strerror})\n`, 2]
    return [`awk: cannot open "${shown}" (${strerror})\n`, 2]
  }
  if (name === 'jq') return [`jq: ${loadFailure(shown, err)}\n`, 2]
  if (name === 'rg') return [`rg: ${shown}:${readFailed ? '' : ' '}${osErrorText(err)}\n`, 2]
  if (name === 'zgrep') return [fsErrorLine('cat', path, err), 2]
  return [fsErrorLine(name, path, err), 2]
}

/**
 * One program file's bytes, read through the dispatcher. A directory opens and
 * fails at its read, which a keyed store's own read cannot tell from nothing
 * being there, so a stat goes first; sed alone reads a directory as an empty
 * script (sed 4.9). Mirrors Python's read_program_file.
 */
export async function readProgramFile(
  name: string,
  path: PathSpec,
  dispatch: DispatchFn,
): Promise<Uint8Array> {
  if ((await dispatchStat(dispatch)(path)).type === FileType.DIRECTORY) {
    if (name === 'sed') return new Uint8Array()
    throw eisdir(path)
  }
  const [data] = await dispatch('read', path)
  return materialize(data as ByteSource)
}

/** The invocation's program files, or an empty list for inline programs. */
export function programFiles(name: string, bag: Record<string, FlagValue>): PathSpec[] {
  return new FlagView(bag, specOf(name)).asPaths(FILE_KEYS[name] ?? 'f')
}

/** Read program files once before input routing or traversal fan-out.
 * Lower to the inline form so every native sub-run sees the same program,
 * including when reading it consumed stdin. Pinned against debian:stable-slim
 * (grep 3.11, sed 4.9, ripgrep 14.1.1).
 * `operands` are the path operands, which rg checks for a `-` once `-f -` has
 * read stdin.
 */
export async function prepareProgram(
  name: string,
  texts: string[],
  bag: Record<string, FlagValue>,
  stdin: ByteSource | null,
  dispatch: DispatchFn,
  operands: readonly PathSpec[] = [],
): Promise<[string[], Record<string, FlagValue>, ByteSource | null, IOResult | null]> {
  const fl = new FlagView(bag, specOf(name))
  const key = FILE_KEYS[name] ?? 'f'
  const files = programFiles(name, bag)
  if (files.length === 0) return [texts, bag, stdin, null]
  const source = resolveSource(stdin)
  let consumed = false
  // Only a literal `-` takes stdin in ripgrep's sense: `-f /dev/stdin` reads
  // the same bytes as a file, so neither refusal follows from it.
  let taken = false
  const pieces: Uint8Array[] = []
  for (const path of files) {
    try {
      if (isStdin(path)) {
        if (name === 'rg' && path.rawPath === '-') {
          if (taken) {
            return [
              texts,
              bag,
              stdin,
              new IOResult({ exitCode: 2, stderr: new TextEncoder().encode(RG_STDIN_REREAD) }),
            ]
          }
          taken = true
        }
        pieces.push(await materialize(source))
        consumed = true
      } else {
        pieces.push(await readProgramFile(name, path, dispatch))
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      // Match GNU's fatal script-open status; ordinary input-file failures
      // still belong to the native command handlers.
      const [line, exitCode] = programFileRefusal(name, path, err)
      return [texts, bag, stdin, new IOResult({ exitCode, stderr: new TextEncoder().encode(line) })]
    }
  }
  if (taken && operands.some((p) => p.rawPath === '-')) {
    return [
      texts,
      bag,
      stdin,
      new IOResult({ exitCode: 2, stderr: new TextEncoder().encode(RG_STDIN_SEARCHED) }),
    ]
  }
  const out = Object.fromEntries(Object.entries(bag).filter(([name]) => name !== key))
  if (name === 'grep' || name === 'rg' || name === 'zgrep') {
    const patternKey = PATTERN_KEYS[name] ?? 'e'
    const expressions = fl.asList(patternKey)
    let pattern = expressions.length > 0 ? expressions.join('\n') : null
    for (const data of pieces) pattern = mergePatternList(pattern, data)
    // An empty pattern-file list preserves grep's zero-pattern sentinel.
    out[key] = []
    out[patternKey] = pattern === null ? [] : [pattern]
  } else if (name === 'sed') {
    const expressions = fl.asList('e').values()
    const scripts = pieces.map((data) => decodeText(data)).values()
    out.e = fl
      .occurrences('e', 'f')
      .map(([kind]) => (kind === 'e' ? expressions : scripts).next().value ?? '')
  } else {
    texts = [pieces.map((data) => decodeText(data)).join('\n'), ...texts]
  }
  return [texts, out, consumed ? source : stdin, null]
}
