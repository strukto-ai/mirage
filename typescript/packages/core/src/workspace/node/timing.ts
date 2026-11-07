import { encodeText } from '../../shell/bytes.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { shellVoice } from '../../shell/voice.ts'

const DEFAULT_FORMAT = '\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS'
const TOKEN = /%(?:([0-9])?(l)?([RUS])|([%P]))/g
const PREFIXES: ReadonlySet<string> = new Set([NT.TIMED_STATEMENT, NT.NEGATED_COMMAND])

/** CPU time is zero: browsers lack per-job counters and process totals include unrelated agents. */
export function timingReport(
  elapsed: number,
  portable: boolean,
  format: string | undefined,
): Uint8Array {
  if (portable) return encodeText(`real ${elapsed.toFixed(2)}\nuser 0.00\nsys 0.00\n`)
  const template = format ?? DEFAULT_FORMAT
  if (template === '') return new Uint8Array()
  const pieces: string[] = []
  let cursor = 0
  for (const match of template.matchAll(TOKEN)) {
    const gap = template.slice(cursor, match.index)
    if (gap.includes('%')) return badEscape(template.slice(cursor + gap.indexOf('%')))
    pieces.push(gap)
    if (match[4] !== undefined) pieces.push(match[4] === '%' ? '%' : '0.00')
    else {
      const precision = Math.min(Number(match[1] ?? 3), 3)
      const value = match[3] === 'R' ? elapsed : 0
      pieces.push(
        match[2] === undefined
          ? value.toFixed(precision)
          : `${String(Math.floor(value / 60))}m${(value % 60).toFixed(precision)}s`,
      )
    }
    cursor = match.index + match[0].length
  }
  const tail = template.slice(cursor)
  if (tail.slice(0, -1).includes('%')) return badEscape(tail.slice(tail.indexOf('%')))
  return encodeText(pieces.join('') + tail + '\n')
}

/**
 * bash's refusal of the `%` escape `rest` starts with: past an optional
 * precision digit and `l`, the character standing where a format letter
 * belongs, NUL at the end of the format. Mirrors Python's _bad_escape.
 */
function badEscape(rest: string): Uint8Array {
  let i = 1
  if (i < rest.length && /[0-9]/.test(rest.charAt(i))) i += 1
  if (i < rest.length && rest.charAt(i) === 'l') i += 1
  const bad = i < rest.length ? rest.charAt(i) : '\0'
  return encodeText(`${shellVoice()}TIMEFORMAT: \`${bad}': invalid format character\n`)
}

/**
 * How a `time` reports its pipeline. bash times a pipeline once, however
 * many `time` words and `!` lead it: the outermost `time` reports,
 * portable when any of them takes `-p`. Null when an outer `time` already
 * times the pipeline. Mirrors Python's timed_by.
 */
export function timedBy(node: TSNodeLike): boolean | null {
  let current = node
  for (
    let parent = node.parent ?? null;
    parent !== null &&
    (PREFIXES.has(parent.type) ||
      (parent.type === NT.PIPELINE && parent.startIndex === current.startIndex));
  ) {
    if (parent.type === NT.TIMED_STATEMENT) return null
    current = parent
    parent = parent.parent ?? null
  }
  let portable = false
  for (
    let inner: TSNodeLike | undefined = node;
    inner !== undefined && (PREFIXES.has(inner.type) || inner.type === NT.PIPELINE);
  ) {
    if (inner.type === NT.TIMED_STATEMENT && inner.children.some((child) => child.type === '-p'))
      portable = true
    inner = inner.namedChildren[0]
  }
  return portable
}
