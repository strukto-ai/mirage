// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync, stdinStream } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()

const WIDTH = 75
const LEEWAY = 7
const DEF_INDENT = 3
const TAB_WIDTH = 8
const MAX_WORDS = 1000
const MAX_CHARS = 5000
const EOF = -1
const LINE_COST = 70 ** 2
const SENTENCE_BONUS = 50 ** 2
const NOBREAK_COST = 600 ** 2
const PAREN_BONUS = 40 ** 2
const PUNCT_BONUS = 40 ** 2
const LINE_CREDIT = 3 ** 2
const MAX_COST = Number.MAX_SAFE_INTEGER
const OPENERS = new Set(ENC.encode('([\'`"'))
const CLOSERS = new Set(ENC.encode(')]\'"'))
const PERIODS = new Set(ENC.encode('.?!'))
const PUNCTUATION = new Set(ENC.encode('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'))
const SPACES = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d])

function shortCost(n: number): number {
  return (n * 10) ** 2
}

function raggedCost(n: number): number {
  return Math.trunc(shortCost(n) / 2)
}

interface Word {
  start: number
  length: number
  space: number
  paren: boolean
  punct: boolean
  period: boolean
  final: boolean
}

/**
 * GNU fmt over one file's bytes, ported from coreutils 9.7 fmt.c.
 *
 * The C keeps its state in globals; here it is this object's, one per
 * file, as fmt() resets `tabs` and `other_indent` for each.
 */
class Formatter {
  private pos = 0
  private readonly prefixLeadSpace: number
  private readonly prefixFullLength: number
  private readonly prefix: Uint8Array
  private out: number[] = []
  private outColumn = 0
  private inColumn = 0
  private nextPrefixIndent = 0
  private prefixIndent = 0
  private firstIndent = 0
  private otherIndent = 0
  private lastLineLength = 0
  private tabs = false
  private nextChar = EOF
  private para: number[] = []
  private words: Word[] = []
  private bestCost: number[] = []
  private nextBreak: number[] = []
  private lineLength: number[] = []

  constructor(
    private readonly data: Uint8Array,
    private readonly maxWidth: number,
    private readonly goalWidth: number,
    prefix: string | null,
    private readonly split: boolean,
    private readonly tagged: boolean,
    private readonly crown: boolean,
    private readonly uniform: boolean,
  ) {
    const lead = prefix ?? ''
    const stripped = lead.replace(/^ +/, '')
    this.prefixLeadSpace = lead.length - stripped.length
    this.prefixFullLength = ENC.encode(stripped).length
    this.prefix = ENC.encode(stripped.replace(/ +$/, ''))
  }

  run(): Uint8Array {
    this.nextChar = this.getPrefix()
    while (this.getParagraph()) {
      this.fmtParagraph()
      this.putParagraph(this.words.length)
    }
    return Uint8Array.from(this.out)
  }

  private getc(): number {
    if (this.pos >= this.data.length) return EOF
    return this.data[this.pos++] ?? EOF
  }

  private getParagraph(): boolean {
    this.lastLineLength = 0
    let c = this.nextChar
    while (
      c === 0x0a ||
      c === EOF ||
      this.nextPrefixIndent < this.prefixLeadSpace ||
      this.inColumn < this.nextPrefixIndent + this.prefixFullLength
    ) {
      c = this.copyRest(c)
      if (c === EOF) {
        this.nextChar = EOF
        return false
      }
      this.out.push(0x0a)
      c = this.getPrefix()
    }
    this.prefixIndent = this.nextPrefixIndent
    this.firstIndent = this.inColumn
    this.para = []
    this.words = []
    c = this.getLine(c)
    this.setOtherIndent(this.samePara(c))
    if (this.split) {
      // A split paragraph is its one line.
    } else if (this.crown || this.tagged) {
      if (this.samePara(c) && (this.crown || this.inColumn !== this.firstIndent)) {
        c = this.getLine(c)
        while (this.samePara(c) && this.inColumn === this.otherIndent) c = this.getLine(c)
      }
    } else {
      while (this.samePara(c) && this.inColumn === this.otherIndent) c = this.getLine(c)
    }
    const last = this.words[this.words.length - 1]
    if (last !== undefined) last.period = last.final = true
    this.nextChar = c
    return true
  }

  private copyRest(c: number): number {
    this.outColumn = 0
    if (this.inColumn > this.nextPrefixIndent || (c !== 0x0a && c !== EOF)) {
      this.putSpace(this.nextPrefixIndent)
      for (const byte of this.prefix) {
        if (this.outColumn === this.inColumn) break
        this.out.push(byte)
        this.outColumn += 1
      }
      if (c !== 0x0a && c !== EOF) this.putSpace(this.inColumn - this.outColumn)
      if (c === EOF && this.inColumn >= this.nextPrefixIndent + this.prefix.length) {
        this.out.push(0x0a)
      }
    }
    while (c !== 0x0a && c !== EOF) {
      this.out.push(c)
      c = this.getc()
    }
    return c
  }

  private samePara(c: number): boolean {
    return (
      this.nextPrefixIndent === this.prefixIndent &&
      this.inColumn >= this.nextPrefixIndent + this.prefixFullLength &&
      c !== 0x0a &&
      c !== EOF
    )
  }

  private getLine(c: number): number {
    for (;;) {
      const word: Word = {
        start: this.para.length,
        length: 0,
        space: 0,
        paren: false,
        punct: false,
        period: false,
        final: false,
      }
      for (;;) {
        if (this.para.length === MAX_CHARS) {
          this.setOtherIndent(true)
          this.flushParagraph(word)
        }
        this.para.push(c)
        c = this.getc()
        if (c === EOF || SPACES.has(c)) break
      }
      word.length = this.para.length - word.start
      this.inColumn += word.length
      this.checkPunctuation(word)
      const start = this.inColumn
      c = this.getSpace(c)
      word.space = this.inColumn - start
      word.final = c === EOF || (word.period && (c === 0x0a || word.space > 1))
      if (c === 0x0a || c === EOF || this.uniform) word.space = word.final ? 2 : 1
      if (this.words.length === MAX_WORDS - 2) {
        this.setOtherIndent(true)
        this.flushParagraph(word)
      }
      this.words.push(word)
      if (c === 0x0a || c === EOF) break
    }
    return this.getPrefix()
  }

  private getPrefix(): number {
    this.inColumn = 0
    let c = this.getSpace(this.getc())
    if (this.prefix.length === 0) {
      this.nextPrefixIndent = Math.min(this.prefixLeadSpace, this.inColumn)
      return c
    }
    this.nextPrefixIndent = this.inColumn
    for (const byte of this.prefix) {
      if (c !== byte) return c
      this.inColumn += 1
      c = this.getc()
    }
    return this.getSpace(c)
  }

  private getSpace(c: number): number {
    for (;;) {
      if (c === 0x20) this.inColumn += 1
      else if (c === 0x09) {
        this.tabs = true
        this.inColumn = (Math.trunc(this.inColumn / TAB_WIDTH) + 1) * TAB_WIDTH
      } else return c
      c = this.getc()
    }
  }

  private checkPunctuation(word: Word): void {
    const at = (i: number): number => this.para[word.start + i] ?? 0
    word.paren = OPENERS.has(at(0))
    word.punct = PUNCTUATION.has(at(word.length - 1))
    let finish = word.length - 1
    while (finish > 0 && CLOSERS.has(at(finish))) finish -= 1
    word.period = PERIODS.has(at(finish))
  }

  private setOtherIndent(sameParagraph: boolean): void {
    if (this.split) this.otherIndent = this.firstIndent
    else if (this.crown) this.otherIndent = sameParagraph ? this.inColumn : this.firstIndent
    else if (this.tagged) {
      if (sameParagraph && this.inColumn !== this.firstIndent) this.otherIndent = this.inColumn
      else if (this.otherIndent === this.firstIndent) {
        this.otherIndent = this.firstIndent === 0 ? DEF_INDENT : 0
      }
    } else this.otherIndent = this.firstIndent
  }

  private flushParagraph(current: Word): void {
    if (this.words.length === 0) {
      this.out.push(...this.para)
      this.para = []
      current.start = 0
      return
    }
    this.fmtParagraph()
    const end = this.words.length
    let splitPoint = end
    let bestBreak = MAX_COST
    let w = this.nextBreak[0] ?? end
    while (w !== end) {
      const after = this.nextBreak[w] ?? end
      const gain = (this.bestCost[w] ?? 0) - (this.bestCost[after] ?? 0)
      if (gain < bestBreak) {
        splitPoint = w
        bestBreak = gain
      }
      if (bestBreak <= MAX_COST - LINE_CREDIT) bestBreak += LINE_CREDIT
      w = after
    }
    this.putParagraph(splitPoint)
    const shift = splitPoint < end ? (this.words[splitPoint]?.start ?? 0) : current.start
    this.para = this.para.slice(shift)
    this.words = this.words.slice(splitPoint)
    for (const word of [...this.words, current]) word.start -= shift
  }

  private fmtParagraph(): void {
    const words = this.words
    const end = words.length
    this.bestCost = new Array<number>(end + 1).fill(0)
    this.nextBreak = new Array<number>(end).fill(end)
    this.lineLength = new Array<number>(end).fill(0)
    for (let start = end - 1; start >= 0; start--) {
      let best = MAX_COST
      let length = start === 0 ? this.firstIndent : this.otherIndent
      let w = start
      length += words[w]?.length ?? 0
      for (;;) {
        w += 1
        let cost = this.lineCost(w, length) + (this.bestCost[w] ?? 0)
        if (start === 0 && this.lastLineLength > 0) {
          cost += raggedCost(length - this.lastLineLength)
        }
        if (cost < best) {
          best = cost
          this.nextBreak[start] = w
          this.lineLength[start] = length
        }
        if (w === end) break
        length += (words[w - 1]?.space ?? 0) + (words[w]?.length ?? 0)
        if (length >= this.maxWidth) break
      }
      this.bestCost[start] = best + this.baseCost(start)
    }
  }

  private baseCost(index: number): number {
    const words = this.words
    const word = words[index]
    let cost = LINE_COST
    const before = words[index - 1]
    if (before !== undefined) {
      if (before.period) cost += before.final ? -SENTENCE_BONUS : NOBREAK_COST
      else if (before.punct) cost -= PUNCT_BONUS
      else if (index > 1 && words[index - 2]?.final === true) {
        cost += Math.trunc(200 ** 2 / (before.length + 2))
      }
    }
    if (word?.paren === true) cost -= PAREN_BONUS
    else if (word?.final === true) cost += Math.trunc(150 ** 2 / (word.length + 2))
    return cost
  }

  private lineCost(following: number, length: number): number {
    const end = this.words.length
    if (following === end) return 0
    let cost = shortCost(this.goalWidth - length)
    if (this.nextBreak[following] !== end) {
      cost += raggedCost(length - (this.lineLength[following] ?? 0))
    }
    return cost
  }

  private putParagraph(finish: number): void {
    this.putLine(0, this.firstIndent)
    let w = this.nextBreak[0] ?? finish
    while (w !== finish) {
      this.putLine(w, this.otherIndent)
      w = this.nextBreak[w] ?? finish
    }
  }

  private putLine(w: number, indent: number): void {
    this.outColumn = 0
    this.putSpace(this.prefixIndent)
    this.out.push(...this.prefix)
    this.outColumn += this.prefix.length
    this.putSpace(indent - this.outColumn)
    const endline = (this.nextBreak[w] ?? this.words.length) - 1
    for (; w !== endline; w++) {
      const word = this.words[w]
      if (word === undefined) break
      this.putWord(word)
      this.putSpace(word.space)
    }
    const last = this.words[w]
    if (last !== undefined) this.putWord(last)
    this.lastLineLength = this.outColumn
    this.out.push(0x0a)
  }

  private putWord(word: Word): void {
    for (let i = 0; i < word.length; i++) this.out.push(this.para[word.start + i] ?? 0)
    this.outColumn += word.length
  }

  private putSpace(space: number): void {
    const target = this.outColumn + space
    if (this.tabs) {
      const tabTarget = Math.trunc(target / TAB_WIDTH) * TAB_WIDTH
      if (this.outColumn + 1 < tabTarget) {
        while (this.outColumn < tabTarget) {
          this.out.push(0x09)
          this.outColumn = (Math.trunc(this.outColumn / TAB_WIDTH) + 1) * TAB_WIDTH
        }
      }
    }
    while (this.outColumn < target) {
      this.out.push(0x20)
      this.outColumn += 1
    }
  }
}

// max_width and goal_width as fmt.c's main sets them.
function widths(width: number | null, goal: number | null): [number, number] {
  const maxWidth = width ?? WIDTH
  if (goal === null) return [maxWidth, Math.trunc((maxWidth * (2 * (100 - LEEWAY) + 1)) / 200)]
  return [width === null ? goal + 10 : maxWidth, goal]
}

interface FmtFlags {
  readonly width: number | null
  readonly goal: number | null
  readonly prefix: string | null
  readonly splitOnly: boolean
  readonly tagged: boolean
  readonly crown: boolean
  readonly uniform: boolean
}

function parseFlags(bag: Record<string, FlagValue>): FmtFlags {
  const fl = new FlagView(bag, specOf('fmt'))
  const widthValue = fl.asStr('width')
  const goalValue = fl.asStr('goal')
  return {
    width: typeof widthValue === 'string' ? Number.parseInt(widthValue, 10) : null,
    goal: typeof goalValue === 'string' ? Number.parseInt(goalValue, 10) : null,
    prefix: fl.asStr('prefix') ?? null,
    splitOnly: fl.asBool('split_only'),
    tagged: fl.asBool('tagged_paragraph'),
    crown: fl.asBool('crown_margin'),
    uniform: fl.asBool('uniform_spacing'),
  }
}

export async function fmtGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  const [maxWidth, goalWidth] = widths(parsed.width, parsed.goal)
  const run = (data: Uint8Array): Uint8Array =>
    new Formatter(
      data,
      maxWidth,
      goalWidth,
      parsed.prefix,
      parsed.splitOnly,
      parsed.tagged,
      parsed.crown,
      parsed.uniform,
    ).run()
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still format (GNU fmt). GNU formats each file on its own: a paragraph
    // never runs from one file into the next. Mirrors Python's fmt.
    const [ok, err] = await readOperands(paths, stream, 'fmt')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts = ok.map((o) => run(o.data))
    const total = parts.reduce((n, part) => n + part.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      result.set(part, offset)
      offset += part.length
    }
    return [result as ByteSource, io]
  }
  const stdinData = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  return [run(stdinData) as ByteSource, new IOResult()]
}
