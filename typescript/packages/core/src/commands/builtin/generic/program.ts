import { PATTERN_KEYS, mergePatternList } from '../grep_pattern.ts'
import { resolveSource } from '../utils/stream.ts'
import { specOf } from '../../spec/index.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'

export const PROGRAM_FILE_COMMANDS = new Set(['grep', 'rg', 'sed', 'awk', 'jq'])

// ripgrep reads patterns from stdin once, and refuses both a second `-f -`
// and a `-` operand after it, exit 2 (14.1.1).
const RG_STDIN_REREAD = 'rg: error reading -f/--file from stdin: stdin has already been consumed\n'
const RG_STDIN_SEARCHED =
  'rg: error: attempted to read patterns from stdin while also searching stdin\n'

// The dest each command's spec gives its program file.
const FILE_KEYS: Readonly<Record<string, string>> = {
  grep: 'file',
  rg: 'file',
  sed: 'f',
  awk: 'f',
  jq: 'from_file',
}

/** The invocation's program files, or an empty list for inline programs. */
export function programFiles(name: string, bag: Record<string, FlagValue>): string[] {
  return new FlagView(bag, specOf(name)).asList(FILE_KEYS[name] ?? 'f')
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
  for (const file of files) {
    const path = PathSpec.fromStrPath(file)
    try {
      if (name !== 'jq' && (file === '-' || file === '/dev/stdin')) {
        if (name === 'rg' && file === '-') {
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
        const [data] = await dispatch('read', path)
        pieces.push(await materialize(data as ByteSource))
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      let line = fsErrorLine(name, path, err)
      if (name === 'sed') line = line.replace('sed: ', "sed: couldn't open file ")
      return [
        texts,
        bag,
        stdin,
        new IOResult({
          exitCode: name === 'sed' ? 4 : 2,
          stderr: new TextEncoder().encode(line),
        }),
      ]
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
  const dec = new TextDecoder()
  if (name === 'grep' || name === 'rg') {
    const patternKey = PATTERN_KEYS[name] ?? 'e'
    const expressions = fl.asList(patternKey)
    let pattern = expressions.length > 0 ? expressions.join('\n') : null
    for (const data of pieces) pattern = mergePatternList(pattern, data)
    // An empty pattern-file list preserves grep's zero-pattern sentinel.
    out[key] = []
    out[patternKey] = pattern === null ? [] : [pattern]
  } else if (name === 'sed') {
    out.e = [...fl.asList('e'), ...pieces.map((data) => dec.decode(data).replace(/\n$/, ''))]
  } else {
    texts = [pieces.map((data) => dec.decode(data)).join('\n'), ...texts]
  }
  return [texts, out, consumed ? source : stdin, null]
}
