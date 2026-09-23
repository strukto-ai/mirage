export const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
}

/** Translate one bracket expression; returns the index past its `]`. */
export function translateBracket(pattern: string, start: number, out: string[]): number {
  let idx = start + 1
  out.push('[')
  if (pattern.charAt(idx) === '^') {
    out.push('^')
    idx += 1
  }
  // A `]` in the first position is a literal member in an ERE, but the
  // host engine would read it as the end of the bracket expression.
  if (pattern.charAt(idx) === ']') {
    out.push('\\]')
    idx += 1
  }
  while (idx < pattern.length) {
    const ch = pattern.charAt(idx)
    if (ch === ']') {
      out.push(']')
      return idx + 1
    }
    if (pattern.startsWith('[:', idx)) {
      const close = pattern.indexOf(':]', idx + 2)
      if (close === -1) {
        out.push('\\[')
        idx += 1
        continue
      }
      const name = pattern.slice(idx + 2, close)
      const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
      if (expansion === undefined) throw new SyntaxError('Invalid character class name')
      out.push(expansion)
      idx = close + 2
      continue
    }
    if (ch === '\\' && idx + 1 < pattern.length) {
      out.push(pattern.slice(idx, idx + 2))
      idx += 2
      continue
    }
    if (ch === '[') {
      out.push('\\[')
      idx += 1
      continue
    }
    out.push(ch)
    idx += 1
  }
  throw new SyntaxError('Unmatched [, [^, [:, [., or [=')
}

export function translateClasses(pattern: string): string {
  const out: string[] = []
  let idx = 0
  while (idx < pattern.length) {
    if (pattern.charAt(idx) === '\\' && idx + 1 < pattern.length) {
      out.push(pattern.slice(idx, idx + 2))
      idx += 2
    } else if (pattern.charAt(idx) === '[') {
      idx = translateBracket(pattern, idx, out)
    } else {
      out.push(pattern.charAt(idx++))
    }
  }
  return out.join('')
}

export function classCharacters(name: string): string {
  const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
  if (expansion === undefined) throw new Error(`tr: invalid character class '${name}'`)
  const pattern = new RegExp('[' + expansion + ']')
  return Array.from({ length: 128 }, (_, n) => String.fromCharCode(n))
    .filter((ch) => pattern.test(ch))
    .join('')
}
