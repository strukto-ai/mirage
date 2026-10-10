/**
 * What every match of a subexpression consumes: `literal` when the text is
 * fixed, and `needles`, one of which it always contains (none known when
 * empty).
 */
interface Required {
  literal: string | null
  needles: readonly string[]
}

const LIMIT = 64
// Long enough for a translated Unicode class: ripgrep's `\b` alone spells its
// word class out four times, some 45,000 characters of host source.
export const LONGEST = 1 << 18
// The ASCII letters a non-ASCII character matches under JavaScript's Unicode
// case folding (the Kelvin sign for k, `ſ` for s): a lowercased byte search
// for a needle holding one could miss a line.
export const UNICODE_FOLDED = /[ks]/
const QUANTIFIER = /[*+?]|\{(?<least>[0-9]+)(?:,[0-9]*)?\}/y
const GROUP = /\?(?:(?<look>=|!|<=|<!)|[:>]|P?<[A-Za-z_$][A-Za-z0-9_$]*>)/y
const UNKNOWN: Required = { literal: null, needles: [] }
const EMPTY: Required = { literal: '', needles: [] }

function literal(text: string): Required {
  return { literal: text, needles: text ? [text] : [] }
}

function strength(part: Required): number {
  return part.needles.length ? Math.min(...part.needles.map((s) => s.length)) : 0
}

function sequence(left: Required, right: Required): Required {
  if (left.literal !== null && right.literal !== null) return literal(left.literal + right.literal)
  return { literal: null, needles: (strength(left) >= strength(right) ? left : right).needles }
}

function either(left: Required, right: Required): Required {
  if (left.literal !== null && left.literal === right.literal) return left
  if (left.needles.length === 0 || right.needles.length === 0) return UNKNOWN
  const needles = [...new Set([...left.needles, ...right.needles])]
  return needles.length <= LIMIT ? { literal: null, needles } : UNKNOWN
}

/** A bounded partial parser: syntax it does not know disables skipping. */
class RequiredLiterals {
  private at = 0
  private valid = true

  constructor(private readonly source: string) {}

  needles(): readonly string[] {
    const required = this.alternation(0)
    return this.valid && this.at === this.source.length ? required.needles : []
  }

  private peek(): string {
    return this.source.charAt(this.at)
  }

  private alternation(depth: number): Required {
    if (depth > LIMIT) {
      this.valid = false
      return UNKNOWN
    }
    let required = this.concatenation(depth)
    while (this.valid && this.peek() === '|') {
      this.at++
      required = either(required, this.concatenation(depth))
    }
    return required
  }

  private concatenation(depth: number): Required {
    let required = EMPTY
    let run: string[] = []
    while (this.valid && !['', '|', ')'].includes(this.peek())) {
      const atom = this.quantified(this.atom(depth))
      if (atom.literal !== null) run.push(atom.literal)
      else {
        required = sequence(sequence(required, literal(run.join(''))), atom)
        run = []
      }
    }
    return sequence(required, literal(run.join('')))
  }

  private quantified(atom: Required): Required {
    if (!['*', '+', '?', '{'].includes(this.peek())) return atom
    QUANTIFIER.lastIndex = this.at
    const bound = QUANTIFIER.exec(this.source)
    if (bound === null) {
      this.valid = false
      return UNKNOWN
    }
    this.at = QUANTIFIER.lastIndex
    if (this.peek() === '?') this.at++
    const least = bound.groups?.least
    if (bound[0] === '+' || (least !== undefined && Number(least) > 0))
      return { literal: null, needles: atom.needles }
    return UNKNOWN
  }

  private atom(depth: number): Required {
    const char = this.peek()
    this.at++
    if (char === '(') return this.group(depth)
    if (char === '[') return this.bracket()
    if (char === '\\') return this.escape()
    if (char === '.') return UNKNOWN
    if (char === '^' || char === '$') return EMPTY
    if (['*', '+', '?', '{', '}'].includes(char)) {
      this.valid = false
      return UNKNOWN
    }
    return literal(char)
  }

  /**
   * A group's requirement; a lookaround consumes nothing. Inline flags,
   * comments, conditionals and named backreferences are refused.
   */
  private group(depth: number): Required {
    GROUP.lastIndex = this.at
    const opener = GROUP.exec(this.source)
    if (opener !== null) this.at = GROUP.lastIndex
    else if (this.peek() === '?') {
      this.valid = false
      return UNKNOWN
    }
    const inner = this.alternation(depth + 1)
    if (this.peek() !== ')') {
      this.valid = false
      return UNKNOWN
    }
    this.at++
    return opener?.groups?.look !== undefined ? EMPTY : inner
  }

  /**
   * Step over a bracket expression, which requires no literal. A leading
   * `]` is a member in Python and closes an empty set in JavaScript, and a
   * `[` inside is a nested set under the `v` flag, so both are refused
   * rather than guessed.
   */
  private bracket(): Required {
    if (this.peek() === '^') this.at++
    if (this.peek() === ']') {
      this.valid = false
      return UNKNOWN
    }
    while (this.at < this.source.length) {
      const member = this.peek()
      this.at++
      if (member === ']') return UNKNOWN
      if (member === '[') break
      if (member === '\\') this.at++
    }
    this.valid = false
    return UNKNOWN
  }

  private escape(): Required {
    const char = this.peek()
    this.at++
    if (char === 'b' || char === 'B') return EMPTY
    if (['d', 'D', 's', 'S', 'w', 'W', 'n', 'r', 't', 'f', 'v'].includes(char)) return UNKNOWN
    if (char !== '' && !/[a-zA-Z0-9]/.test(char)) return literal(char)
    this.valid = false
    return UNKNOWN
  }
}

/**
 * Byte-view literals, one of which every line `pat` matches contains.
 * Under `i` they are lowercase, for a search of a lowercased view. Unicode
 * case folding (`i` with `u` or `v`) matches non-ASCII spellings of two ASCII
 * letters (`ſ` for `s`), which only the line matcher can see, so under it a
 * needle holding one of them gives the pattern none.
 */
export function requiredNeedles(pat: RegExp): string[] | null {
  if (pat.global || pat.sticky || pat.source.length > LONGEST || /[^\x20-\x7e]/.test(pat.source))
    return null
  const found = new RequiredLiterals(pat.source).needles()
  const needles = pat.ignoreCase ? [...new Set(found.map((s) => s.toLowerCase()))] : [...found]
  const unicodeFold = pat.ignoreCase && (pat.unicode || pat.flags.includes('v'))
  if (unicodeFold && needles.some((needle) => UNICODE_FOLDED.test(needle))) return null
  return needles.length > 0 ? needles : null
}
