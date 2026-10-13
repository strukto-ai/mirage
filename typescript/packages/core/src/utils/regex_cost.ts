import { LOOP_BUDGET } from '../concurrency/constants.ts'

const QUANTIFIER = /\{(\d+)(,?)(\d*)\}/y
const FLAGS = /\(\?([ims]*)(?:-([ims]*))?:/y
const LOOKAROUNDS = ['(?=', '(?!', '(?<=', '(?<!'] as const

/**
 * How far a backtracking search of a pattern can branch: the steps one path
 * takes outside unbounded repeats (a lookaround's body included), the paths
 * through alternation and bounded repeats, the unbounded repeats, each up to
 * one count per subject character, and the steps one such count takes at
 * most: a repeated group's whole width, a lookaround inside it included,
 * though the count matches one character.
 */
interface Shape {
  width: number
  choices: number
  repeats: number
  scale: number
}

const ZERO_WIDTH: Shape = { width: 0, choices: 1, repeats: 0, scale: 1 }
const ONE_CHAR: Shape = { width: 1, choices: 1, repeats: 0, scale: 1 }

/**
 * Read a pattern's source into its search shape, or null for every construct
 * whose backtracking has no bound in the subject's length that this reading
 * can state: a backreference, a repeated group that branches or repeats
 * inside, a lookaround that repeats, or anything it does not recognize.
 */
class Reader {
  pos = 0
  depth = 0
  branches = 1

  constructor(
    private readonly source: string,
    private readonly sets: boolean,
  ) {}

  alternation(): Shape | null {
    const branches: Shape[] = []
    for (;;) {
      const branch = this.sequence()
      if (branch === null) return null
      branches.push(branch)
      if (!this.source.startsWith('|', this.pos)) break
      this.pos += 1
    }
    if (this.depth === 0) this.branches = branches.length
    return {
      width: Math.max(...branches.map((b) => b.width)),
      choices: branches.reduce((sum, b) => sum + b.choices, 0),
      repeats: Math.max(...branches.map((b) => b.repeats)),
      scale: Math.max(...branches.map((b) => b.scale)),
    }
  }

  sequence(): Shape | null {
    let width = 0
    let choices = 1
    let repeats = 0
    let scale = 1
    while (this.pos < this.source.length && !'|)'.includes(this.source[this.pos] ?? '')) {
      const item = this.item()
      if (item === null) return null
      const shape = this.repeated(...item)
      if (shape === null) return null
      width += shape.width
      choices *= shape.choices
      repeats += shape.repeats
      scale = Math.max(scale, shape.scale)
    }
    return { width, choices, repeats, scale }
  }

  item(): [Shape, boolean] | null {
    const char = this.source[this.pos] ?? ''
    if (char === '(') return this.group()
    if (char === '[') return this.charClass()
    if (char === '\\') return this.escape()
    if ('*+?'.includes(char)) return null
    this.pos += 1
    if (char === '^' || char === '$') return [ZERO_WIDTH, false]
    return [ONE_CHAR, true]
  }

  group(): [Shape, boolean] | null {
    const { source } = this
    const start = this.pos
    const lookaround = LOOKAROUNDS.some((prefix) => source.startsWith(prefix, start))
    if (source.startsWith('(?:', start)) this.pos += 3
    else if (lookaround) this.pos += source.startsWith('(?<', start) ? 4 : 3
    else if (source.startsWith('(?<', start)) {
      const close = source.indexOf('>', start)
      if (close < 0) return null
      this.pos = close + 1
    } else if (source.startsWith('(?', start)) {
      FLAGS.lastIndex = start
      if (FLAGS.exec(source) === null) return null
      this.pos = FLAGS.lastIndex
    } else this.pos += 1
    this.depth += 1
    const inner = this.alternation()
    this.depth -= 1
    if (inner === null || !source.startsWith(')', this.pos)) return null
    this.pos += 1
    if (lookaround) {
      if (inner.repeats > 0) return null
      return [{ ...inner, repeats: 0 }, false]
    }
    return [inner, inner.choices === 1 && inner.repeats === 0 && inner.width > 0]
  }

  charClass(): [Shape, boolean] | null {
    const { source } = this
    let end = this.pos + 1
    let depth = 1
    while (end < source.length) {
      const char = source[end]
      if (char === '\\') end += 2
      else if (char === '[' && this.sets) {
        depth += 1
        end += 1
      } else if (char === ']') {
        depth -= 1
        if (depth === 0) break
        end += 1
      } else end += 1
    }
    if (end >= source.length) return null
    this.pos = end + 1
    return [ONE_CHAR, true]
  }

  escape(): [Shape, boolean] | null {
    const { source } = this
    const start = this.pos
    const char = source[start + 1]
    if (char === undefined || '123456789k'.includes(char)) return null
    if (char === 'b' || char === 'B') {
      this.pos += 2
      return [ZERO_WIDTH, false]
    }
    if ((char === 'u' && source[start + 2] === '{') || char === 'p' || char === 'P') {
      const close = source.indexOf('}', start)
      if (close < 0) return null
      this.pos = close + 1
    } else this.pos += ({ x: 4, u: 6, c: 3 } as Record<string, number>)[char] ?? 2
    return [ONE_CHAR, true]
  }

  repeated(shape: Shape, repeatable: boolean): Shape | null {
    const { source } = this
    const start = this.pos
    const char = source[start] ?? ''
    let low: number
    let high: number | null
    if ('*+?'.includes(char) && char !== '') {
      low = char === '+' ? 1 : 0
      high = char === '?' ? 1 : null
      this.pos += 1
    } else {
      if (char !== '{') return shape
      QUANTIFIER.lastIndex = start
      const bounds = QUANTIFIER.exec(source)
      if (bounds === null) return shape
      low = Number(bounds[1])
      high = bounds[3] ? Number(bounds[3]) : bounds[2] ? null : low
      this.pos = QUANTIFIER.lastIndex
    }
    if (!repeatable) return null
    if (source.startsWith('?', this.pos)) this.pos += 1
    if (high === null)
      return {
        width: low * shape.width,
        choices: 1,
        repeats: 1,
        scale: Math.max(shape.scale, shape.width),
      }
    return { width: high * shape.width, choices: high - low + 1, repeats: 0, scale: shape.scale }
  }
}

/**
 * The steps a search of one subject can take, at most: each start tries
 * every path, up to `length + 1` counts per unbounded repeat times the
 * choices, each path walking its width and each count taking up to `scale`
 * steps. An anchored pattern fails at once past its first start.
 */
function searchCost(shape: Shape, length: number, anchored: boolean): number {
  const path = shape.choices * (length + 1) ** shape.repeats * (shape.width + 2) * shape.scale
  return anchored ? length + 1 + path : (length + 1) * path
}

/**
 * The longest subject a search of `pattern` can run on the loop. A subject up
 * to this length has a worst case within LOOP_BUDGET steps, so it is searched
 * in place; a longer one, and every subject of a pattern whose shape cannot be
 * bounded (-1), goes to a worker. The reading is conservative: some shapes
 * that would finish fast still take the worker, and a linear-time engine
 * would remove the worker for all but backreferences
 * (strukto-ai/mirage#1590).
 */
export function loopLimit(pattern: RegExp): number {
  const reader = new Reader(pattern.source, pattern.flags.includes('v'))
  const shape = reader.alternation()
  if (shape === null || reader.pos !== pattern.source.length) return -1
  const anchored =
    !pattern.flags.includes('m') && reader.branches === 1 && pattern.source.startsWith('^')
  if (searchCost(shape, 0, anchored) > LOOP_BUDGET) return -1
  let low = 0
  let high = LOOP_BUDGET
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (searchCost(shape, middle, anchored) <= LOOP_BUDGET) low = middle
    else high = middle - 1
  }
  return low
}
