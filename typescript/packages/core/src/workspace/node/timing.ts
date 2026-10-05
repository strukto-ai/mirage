import { encodeText } from '../../shell/bytes.ts'

const DEFAULT_FORMAT = '\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS'
const TOKEN = /%(?:([0-9])?(l)?([RUS])|([%P]))/g

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
    if (gap.includes('%')) return encodeText('mirage: TIMEFORMAT: invalid format character\n')
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
  if (tail.includes('%')) return encodeText('mirage: TIMEFORMAT: invalid format character\n')
  return encodeText(pieces.join('') + tail + '\n')
}
