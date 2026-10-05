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

/** Expand a class to its ordered C-locale characters for tr, or null for no such class. */
export function classCharacters(name: string): string | null {
  const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
  if (expansion === undefined) return null
  const pattern = new RegExp('[' + expansion + ']')
  return Array.from({ length: 128 }, (_, n) => String.fromCharCode(n))
    .filter((ch) => pattern.test(ch))
    .join('')
}

// What each `.` and negated bracket checks first under a UTF-8 locale: a byte
// that is no part of a character rides the text as its surrogate escape, and
// glibc matches it with neither.
const RAW_BYTE_GUARD = '(?![\\udc80-\\udcff])'

/** The index past the `]` closing the bracket opened at `start`. */
function bracketEnd(source: string, start: number): number {
  let idx = start + 1
  if (source.charAt(idx) === '^') idx += 1
  while (idx < source.length) {
    const ch = source.charAt(idx)
    if (ch === '\\') idx += 2
    else if (ch === ']') return idx + 1
    else idx += 1
  }
  return source.length
}

/**
 * Keep `.` and a negated bracket off a byte that is no character. glibc's
 * matcher in a UTF-8 locale reads an invalid byte as no character at all, so
 * neither `.` nor `[^x]` matches it (`printf 'a\377b\n' | grep -c 'a.b'` is
 * 0). The text carries such a byte as its surrogate escape, which both would
 * otherwise match; a lookahead before each keeps it out and leaves what `.`
 * means for a newline to the flags. Mirrors Python's `skip_raw_bytes`.
 */
export function skipRawBytes(source: string): string {
  const out: string[] = []
  let idx = 0
  while (idx < source.length) {
    const ch = source.charAt(idx)
    if (ch === '\\') {
      out.push(source.slice(idx, idx + 2))
      idx += 2
    } else if (ch === '[') {
      const end = bracketEnd(source, idx)
      const bracket = source.slice(idx, end)
      out.push(bracket.startsWith('[^') ? `(?:${RAW_BYTE_GUARD}${bracket})` : bracket)
      idx = end
    } else {
      out.push(ch === '.' ? `(?:${RAW_BYTE_GUARD}.)` : ch)
      idx += 1
    }
  }
  return out.join('')
}

/**
 * Compile translated POSIX regex source with deterministic C-locale case
 * folding. Classes, word boundaries and case folding stay the C locale's ASCII
 * ones under a UTF-8 locale (`utf8`) too; what changes there is the subject,
 * which is text, so the source compiles with `u` (a character past U+FFFF is
 * one match, not two halves) and `.` and a negated bracket never match a byte
 * that is no part of a character.
 */
export function compilePosixRegex(source: string, flags = '', utf8 = false): RegExp {
  const hostFlags = utf8 && !flags.includes('u') ? flags + 'u' : flags
  const normalized = asciiSpaceEscapes(source, hostFlags.includes('u'))
  const subject = utf8 ? skipRawBytes(normalized) : normalized
  return hostFlags.includes('i')
    ? new AsciiIgnoreCaseRegex(subject, hostFlags)
    : new RegExp(subject, hostFlags)
}

// JavaScript's \s stays Unicode-aware even without u; Python re.ASCII does not.
// Under u, `\S` reaches every code point rather than stopping at U+FFFF.
function spaceEscapes(unicode: boolean): Readonly<Record<string, string>> {
  return {
    '\\s': '\\x09-\\x0d\\x20',
    '\\S': `\\x00-\\x08\\x0e-\\x1f\\x21-${unicode ? '\\u{10ffff}' : '\\uffff'}`,
  }
}

function asciiSpaceEscapes(source: string, unicode: boolean): string {
  const escapes = spaceEscapes(unicode)
  return source.replace(/\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]/g, (token) => {
    if (token.startsWith('['))
      return token.replace(/\\[\s\S]/g, (escape) => escapes[escape] ?? escape)
    const expansion = escapes[token]
    return expansion === undefined ? token : `[${expansion}]`
  })
}

/** Fold only ASCII letters, without changing UTF-16 offsets or non-ASCII text. */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase())
}

// Scan complete escapes, classes and named group openers before literal letters.
// Lowercasing regex source directly would turn \\D into \\d and [Z-a] into [z-a].
const FOLD_TOKEN =
  /\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|u\{[\da-fA-F]+\}|c[A-Za-z]|k<[^>]+>|[\s\S])|\[(?:\\[\s\S]|[^\]\\])*\]|\(\?<[^=!][^>]*>|[A-Z]/g

// Under `u` a bracket is read with `u` too, so a `\u{...}` member is one code
// point rather than the letters of its spelling.
function foldRegexSource(source: string, unicode: boolean): string {
  return source.replace(FOLD_TOKEN, (token) => {
    if (token.startsWith('[')) {
      const bracket = new RegExp(token, unicode ? 'u' : '')
      const negated = token.startsWith('[^')
      let letters = ''
      for (let code = 97; code <= 122; code++) {
        const lower = String.fromCharCode(code)
        const upper = lower.toUpperCase()
        if (negated ? !bracket.test(upper) : bracket.test(upper)) letters += lower
      }
      if (!letters) return token
      return negated ? `(?:(?![${letters}])${token})` : `(?:${token}|[${letters}])`
    }
    if (token.startsWith('(?<') || token.startsWith('\\k<')) return token
    if (/^\\(?:[xu][\da-fA-F]+|u\{[\da-fA-F]+\})$/.test(token)) {
      const code = Number.parseInt(token.replace(/[\\xu{}]/g, ''), 16)
      return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : token
    }
    if (token.startsWith('\\')) return token
    return foldAscii(token)
  })
}

/**
 * Match folded text so backreferences also ignore ASCII case. Recover every
 * capture from its original span: grep -o and sed replacements must preserve
 * the input's spelling. The public source/flags remain cloneable through
 * compilePosixRegex; the private matcher never enables JavaScript's Unicode i.
 */
class AsciiIgnoreCaseRegex extends RegExp {
  private readonly folded: RegExp
  private input: string | undefined
  private foldedInput = ''

  constructor(source: string | RegExp, flags?: string) {
    super(source, flags)
    const foldedFlags = this.flags.replace('i', '')
    this.folded = new RegExp(
      foldRegexSource(this.source, this.unicode),
      foldedFlags.includes('d') ? foldedFlags : foldedFlags + 'd',
    )
  }

  override exec(text: string): RegExpExecArray | null {
    this.folded.lastIndex = this.lastIndex
    if (text !== this.input) {
      this.input = text
      this.foldedInput = foldAscii(text)
    }
    const match = this.folded.exec(this.foldedInput)
    this.lastIndex = this.folded.lastIndex
    if (match === null) return null
    const indices = match.indices
    if (indices === undefined) throw new Error('ASCII matcher requires capture indices')
    for (let index = 0; index < match.length; index++) {
      const span = indices[index]
      if (span !== undefined) match[index] = text.slice(span[0], span[1])
    }
    if (match.groups !== undefined && indices.groups !== undefined) {
      for (const name of Object.keys(indices.groups)) {
        const span = indices.groups[name]
        if (span !== undefined) match.groups[name] = text.slice(span[0], span[1])
      }
    }
    match.input = text
    if (!this.hasIndices) delete match.indices
    return match
  }
}
