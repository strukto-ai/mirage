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

import { describe, expect, it } from 'vitest'

import { chunks } from '../../../io/cooperative.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { fmtGeneric } from './fmt.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type Flags = Context['flags']

// Every expectation below is what GNU coreutils 9.7 fmt printed for the same
// input and flags. Mirrors test_fmt.py.
const CASES: [string, Flags, string, string][] = [
  // Layout costs: each input sits on a tie or a near tie, so moving one cost
  // by a hundredth of a squared column changes the output.
  ['cost_line_and_goal', { width: '10', goal: '0' }, 'e, efaadg (edb\n', 'e,\nefaadg\n(edb\n'],
  ['cost_uneven', { width: '11' }, '(fd. ae. (af gjhfhj,\n', '(fd.\nae. (af\ngjhfhj,\n'],
  [
    'cost_sentence_end',
    { width: '18', goal: '10' },
    'ghiad, (dhccdi.  (g.\n',
    'ghiad,\n(dhccdi.  (g.\n',
  ],
  ['cost_mark_end', { width: '10' }, 'fij (f, fe, (jecgg.\n', 'fij\n(f, fe,\n(jecgg.\n'],
  ['cost_opener_start', { width: '9' }, 'jh, ejhj (j.  b df,\n', 'jh,\nejhj (j.\nb df,\n'],
  [
    'cost_first_alone',
    { width: '13' },
    'h fj.  acchc dcfiaa.  jj hie (iifcc (ebbja jhcc\n',
    'h fj.  acchc\ndcfiaa.\njj hie\n(iifcc\n(ebbja jhcc\n',
  ],
  ['cost_last_alone', { width: '9', goal: '9' }, 'dc jggg hc,\n', 'dc\njggg hc,\n'],
  [
    'cost_false_stop_tie_goes_to_the_shorter_line',
    { width: '63', goal: '0' },
    `aaaa. ${'b'.repeat(54)} ${'c'.repeat(7)}\n`,
    `aaaa.\n${'b'.repeat(54)} ${'c'.repeat(7)}\n`,
  ],
  [
    'cost_false_stop_outweighs_a_long_line',
    { width: '64', goal: '0' },
    `aaaa. ${'b'.repeat(54)} ${'c'.repeat(8)}\n`,
    `aaaa. ${'b'.repeat(54)}\n${'c'.repeat(8)}\n`,
  ],
  ['short_last_word_kept_with_another', { width: '10' }, 'aaaa bbbb cc\n', 'aaaa\nbbbb cc\n'],
  ['two_words_stay_under_the_width', { width: '10' }, 'aaaa bbbbb\n', 'aaaa\nbbbbb\n'],
  [
    'remainder_weighs_the_line_after',
    { width: '33', goal: '13' },
    'dgmvxmkm knkgnmgs bmdmfkrnsj pqfknn hbcf dwqhc nbxp sfnfwpn\n',
    'dgmvxmkm knkgnmgs\nbmdmfkrnsj\npqfknn hbcf dwqhc nbxp sfnfwpn\n',
  ],
  [
    'default_goal_rounds_down',
    { width: '107' },
    'h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh' +
      ' b hfcfb gge edf bcag bcafhga gafhf ghad eb gdgcaff ebhbg bfbahc ga' +
      ' bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae' +
      ' gdcf fh\n',
    'h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh' +
      ' b hfcfb gge edf bcag bcafhga gafhf\nghad eb gdgcaff ebhbg bfbahc ga' +
      ' bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae' +
      '\ngdcf fh\n',
  ],
  [
    'goal_alone_allows_ten_more',
    { goal: '20' },
    'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii\n',
    'aaaa bbbb cccc dddd\neeee ffff gggg hhhh iiii\n',
  ],
  ['zero_width_puts_a_word_per_line', { width: '0' }, 'one two three\n', 'one\ntwo\nthree\n'],
  // Blanks: tabs are written only once the input has shown one, and only
  // where they take fewer bytes than spaces.
  ['tab_not_shorter', {}, 'abcdefg  h\tx\n', 'abcdefg  h\tx\n'],
  ['tab_shorter', {}, 'abcdef  h\tx\n', 'abcdef\th\tx\n'],
  ['tab_in_next_indent_counts', {}, 'abc     d\n\ta\nabc     d\n', 'abc\td\n\ta\nabc\td\n'],
  ['tab_later_in_next_line_does_not', {}, 'abc     d\n  x\ty\n', 'abc     d\n  x\ty\n'],
  ['gap_keeps_its_typed_columns', {}, 'abc     d\nx\ty\n', 'abc\td x\t  y\n'],
  ['carriage_return_starts_a_word', { width: '8' }, 'aaaa\rbbbb cccc\n', 'aaaa\n\rbbbb\ncccc\n'],
  ['width_counts_bytes', { width: '9' }, 'éé bbbb\n', 'éé\nbbbb\n'],
  // Sentence ends.
  [
    'closing_quote_keeps_a_sentence_end',
    { uniform_spacing: true },
    'x end.)  next\n',
    'x end.)  next\n',
  ],
  ['closing_brace_does_not', { uniform_spacing: true }, 'x end.}  next\n', 'x end.} next\n'],
  [
    'tab_gap_ends_a_sentence_from_two_columns',
    { uniform_spacing: true },
    'abcde.\tnext\nabcdef.\tnext\n',
    'abcde.\tnext abcdef. next\n',
  ],
  // Prefixes.
  [
    'prefix_spaces_are_floors',
    { prefix: ' # ', width: '10' },
    '# aaa bbb ccc\n # aaa bbb ccc\n\t# aaa bbb ccc\n #aaa bbb ccc\n',
    '# aaa bbb ccc\n # aaa\n # bbb\n # ccc\n\t# aaa\n\t# bbb\n\t# ccc\n #aaa bbb ccc\n',
  ],
  [
    'prefix_tab_matches_as_typed',
    { prefix: '#\t', width: '10' },
    '#\taaa bbb ccc\n# aaa bbb ccc\n',
    '#\taaa\n#\tbbb ccc\n# aaa bbb ccc\n',
  ],
  ['prefix_copy_rewrites_blanks_past_it', { prefix: ' # ' }, '\tq\n#        x\n', '\tq\n#\t x\n'],
  ['prefix_lines_share_their_lead', { prefix: '#' }, ' #  a\n #  b\n  # c\n', ' #  a b\n  # c\n'],
  ['prefix_only_line_prints_bare', { prefix: '# ' }, '# \n#   \n  #  a b\n', '#\n#\n  #  a b\n'],
  // The input's last line without a newline.
  ['copied_last_line_stays_without', { prefix: '#' }, '#a\n  x  ', '#a\n  x  '],
  [
    'space_prefix_wants_its_columns',
    { prefix: '  ', width: '10' },
    '  aaa bbb ccc\n aaa bbb\n    aaa bbb ccc\n  \n   \n\taaa bbb ccc\n',
    '  aaa\n  bbb ccc\n aaa bbb\n    aaa\n    bbb\n    ccc\n\n  \n  \taaa\n  \tbbb\n  \tccc\n',
  ],
  ['bare_prefix_last_line_gets_one', { prefix: '  #' }, '#', '#\n'],
  ['blank_last_line_gets_one', {}, 'a\n   ', 'a\n\n'],
  // Indentation under -t, -c and -s.
  [
    'tagged_one_line_hangs_three',
    { tagged_paragraph: true, width: '8' },
    'aaa bbb ccc\n',
    'aaa bbb\n   ccc\n',
  ],
  [
    'tagged_one_line_keeps_the_last_hang',
    { tagged_paragraph: true, width: '12' },
    '  a\n    b\n\n    xx yy zz ww\n\n    pp qq rr ss\n',
    '  a b\n\n    xx yy\nzz ww\n\n    pp qq\nrr ss\n',
  ],
  [
    'tagged_hang_left_of_the_prefix',
    { tagged_paragraph: true, width: '10', prefix: '#' },
    '#xx aaaa bbbb\n',
    '#xx\n#aaaa bbbb\n',
  ],
  [
    'crown_one_line_keeps_its_indent',
    { crown_margin: true, width: '8' },
    'aaa bbb ccc\n',
    'aaa\nbbb ccc\n',
  ],
  [
    'crown_wins_over_tagged',
    { crown_margin: true, tagged_paragraph: true },
    'a b\nc d\ne f\n',
    'a b c d e f\n',
  ],
  [
    'split_keeps_each_line_and_its_indent',
    { split_only: true, width: '6' },
    '  aaa bbb ccc\nddd eee\n',
    '  aaa\n  bbb\n  ccc\nddd\neee\n',
  ],
]

async function run(stdin: ByteSource, flags: Flags = {}): Promise<Uint8Array> {
  const ctx = { stdin, flags, cwd: PathSpec.fromStrPath('/') } as Context
  const [out, io] = fmtGeneric([], ctx, () => {
    throw new Error('fmt read a file')
  }) as [ByteSource, { exitCode: number }]
  const bytes = await materialize(out)
  expect(io.exitCode).toBe(0)
  return bytes
}

function lcgStep(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
}

// The same generator as the Python test's, kept within 31 bits.
function lcgWords(seed: number, count: number): string[] {
  const words: string[] = []
  let x = seed
  for (let i = 0; i < count; i++) {
    x = lcgStep(x)
    let word = ''
    for (let j = 2 + ((x >> 16) % 7); j > 0; j--) {
      x = lcgStep(x)
      word += 'abcdefgh'.charAt((x >> 16) % 8)
    }
    words.push(word)
  }
  return words
}

function cycleWords(count: number): string[] {
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    let word = ''
    for (let j = 0; j < 1 + ((i * 5) % 9); j++) word += 'abcdefgh'.charAt((i * 7 + j) % 8)
    words.push(word)
  }
  return words
}

function markedWords(seed: number, count: number): string[] {
  return lcgWords(seed, count).map((word, i) => {
    if (i % 7 === 3) return `${word},`
    return i % 11 === 5 ? `${word}.` : word
  })
}

function sentenceWords(seed: number, count: number): string {
  return lcgWords(seed, count)
    .map((word, i) => (i % 3 === 2 ? `${word}.  ` : `${word} `))
    .join('')
}

// Word text reaching exactly 5000 bytes, then a one-byte word.
function fullPieceWords(): string[] {
  const pool = lcgWords(157, 2000)
  const words: string[] = []
  let size = 0
  while (size < 4990) {
    const word = pool[words.length] ?? ''
    words.push(word)
    size += word.length
  }
  const rest = pool.slice(words.length, words.length + 40)
  return [...words, 'q'.repeat(5000 - size), 'x', ...rest]
}

function abcdWords(count: number): string {
  return new Array<string>(count).fill('abcd').join(' ')
}

// Repeats one chunk forever, failing once fmt holds more than `limit` bytes
// of it unprinted. Mirrors the Python test's `_Endless`.
class Endless implements AsyncIterableIterator<Uint8Array> {
  sent = 0
  got = 0

  constructor(
    private readonly chunk: Uint8Array,
    private readonly limit: number,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const held = this.sent - this.got
    if (held > this.limit) return Promise.reject(new Error(`fmt holds ${String(held)} bytes`))
    this.sent += this.chunk.length
    return Promise.resolve({ done: false, value: this.chunk })
  }
}

async function readEndless(source: Endless, upto: number, flags: Flags = {}): Promise<void> {
  const ctx = { stdin: source, flags, cwd: PathSpec.fromStrPath('/') } as Context
  const [out] = fmtGeneric([], ctx, () => {
    throw new Error('fmt read a file')
  }) as [ByteSource, { exitCode: number }]
  for await (const part of chunks(out)) {
    source.got += part.length
    if (source.got >= upto) return
  }
}

function wordsPerLine(out: Uint8Array): number[] {
  return DEC.decode(out)
    .split('\n')
    .slice(0, -1)
    .map((line) => line.split(/\s+/).filter((w) => w !== '').length)
}

describe('fmt', () => {
  it.each(CASES)('%s matches GNU', async (_name, flags, input, expected) => {
    expect(DEC.decode(await run(ENC.encode(input), flags))).toBe(expected)
  })

  it('gives the same output however the input is split', async () => {
    const data = ENC.encode('#  one two.  three\n# four\tfive six seven eight nine ten\n\n#x\n')
    const flags = { prefix: '#', width: '12' }
    const whole = await run(data, flags)
    async function* pieces(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < data.length; i++) yield await Promise.resolve(data.subarray(i, i + 1))
    }
    expect(await run(pieces(), flags)).toEqual(whole)
  })

  it('holds 998 words in a piece', async () => {
    const out = await run(ENC.encode(`${new Array<string>(999).fill('a').join(' ')}\n`))
    const counts = [...new Array<number>(11).fill(35), ...new Array<number>(17).fill(36), 2]
    expect(wordsPerLine(out)).toEqual(counts)
  })

  it('holds 5000 bytes of words in a piece', async () => {
    const out = await run(ENC.encode(`${fullPieceWords().join(' ')}\n`), { width: '40' })
    expect(wordsPerLine(out).join('')).toBe(
      '567669678666667766655675565664767676666756546755677555776775755667' +
        '666665867687585566667667667665677875565767766575676655766776566667' +
        '6575977566766666677668765577657785753',
    )
  })

  it("weighs a piece's first line against the last printed", async () => {
    const out = await run(ENC.encode(`${cycleWords(1300).join(' ')}\n`), { width: '40' })
    expect(wordsPerLine(out).join('')).toBe(
      `7${'6'.repeat(162)}7${'6'.repeat(3)}5${'6'.repeat(46)}762`,
    )
  })

  it("has read the next word's blanks when a piece of 998 words prints", async () => {
    // The tab after the 999th word is read before the first piece prints.
    const out = await run(ENC.encode(`        ${abcdWords(999)}\t${abcdWords(101)}\n`), {
      width: '40',
    })
    const lines = DEC.decode(out).split('\n').slice(0, -1)
    expect(lines).toHaveLength(184)
    expect(lines.every((line) => line.startsWith('\t'))).toBe(true)
  })

  it('carries the lines a piece with punctuation weighs best', async () => {
    const out = await run(ENC.encode(`${markedWords(1, 1300).join(' ')}\n`), { width: '40' })
    expect(wordsPerLine(out).join('')).toBe(
      '754465585655665766666657555656566577665657666565456655666665555656' +
        '665565577776574656556675566555575477667566664565556665775766566768' +
        '567565446667765476546656657555656576556567864646565677776566766955' +
        '5568655676566865565557568674',
    )
  })

  it("prints a word filling a piece's first 5000 bytes bare", async () => {
    const out = await run(ENC.encode(`a ${'x'.repeat(5010)} b\n`), { width: '30' })
    expect(DEC.decode(out)).toBe(`a\n${'x'.repeat(5010)} b\n`)
  })

  it('hangs a crown line past a piece from the word that overflowed', async () => {
    // The 501st word does not fit the piece; it starts in input column
    // 8 + 500 * 11 = 5508, and the piece's later lines start there too.
    const data = `\t${new Array<string>(520).fill('abcdefghij').join(' ')}\n`
    const out = await run(ENC.encode(data), { crown_margin: true, width: '40' })
    const pair = '\tabcdefghij abcdefghij'
    expect(DEC.decode(out).split('\n').slice(0, -1)).toEqual([
      pair,
      ...new Array<string>(497).fill(`${'\t'.repeat(688)}    abcdefghij`),
      ...new Array<string>(10).fill(pair),
      '\tabcdefghij',
    ])
  })

  it("does not count a piece's first word as a sentence's", async () => {
    const out = await run(ENC.encode(`${sentenceWords(10, 1300).trimEnd()}\n`), { width: '14' })
    const counts = wordsPerLine(out).join('')
    expect(counts).toHaveLength(784)
    expect(counts.slice(540, 600)).toBe(
      '111121212212322222222121222212122121211112123131111212212121',
    )
  })

  it('fills a piece on bytes before the word ends', async () => {
    // The piece is printed before the tab after the long word is read.
    const data = `        ${new Array<string>(998).fill('a').join(' ')} ${'x'.repeat(4100)}\tb c d e\n`
    const lines = DEC.decode(await run(ENC.encode(data), { width: '40' }))
      .split('\n')
      .slice(0, -1)
    expect(lines).toHaveLength(68)
    expect(lines.slice(0, 65).every((line) => line.startsWith('        a'))).toBe(true)
    expect(lines.slice(65)).toEqual([
      `\t${new Array<string>(16).fill('a').join(' ')}`,
      `\t${'x'.repeat(4100)}`,
      '\tb c d e',
    ])
  })

  it('gives a word printed bare no columns', async () => {
    // After the bare 5000 bytes the line goes on in column 8, so the piece
    // that fills at the 501st word hangs from 8 + 1 + 1 + 499 * 11 = 5499.
    const data = `\t${'x'.repeat(5001)} ${new Array<string>(520).fill('abcdefghij').join(' ')}\n`
    const out = await run(ENC.encode(data), { crown_margin: true, width: '40' })
    const lines = DEC.decode(out).split('\n').slice(0, -1)
    expect(lines[0]).toBe(`${'x'.repeat(5000)}\tx abcdefghij abcdefghij`)
    expect(lines.slice(1, 497)).toEqual(
      new Array<string>(496).fill(`${'\t'.repeat(687)}   abcdefghij`),
    )
    expect(lines.slice(497)).toEqual(new Array<string>(11).fill('\tabcdefghij abcdefghij'))
  })

  it('prints a line that never ends a piece at a time', async () => {
    const source = new Endless(ENC.encode('abcd '.repeat(200)), 8000)
    await readEndless(source, 200_000, { width: '40' })
    expect(source.got).toBeGreaterThanOrEqual(200_000)
  })

  it('prints a word that never ends 5000 bytes at a time', async () => {
    const source = new Endless(ENC.encode('x'.repeat(1000)), 7000)
    await readEndless(source, 200_000)
    expect(source.got).toBeGreaterThanOrEqual(200_000)
  })

  it('streams a copied line that never ends', async () => {
    const source = new Endless(ENC.encode('abcd '.repeat(200)), 2000)
    await readEndless(source, 200_000, { prefix: '#' })
    expect(source.got).toBeGreaterThanOrEqual(200_000)
  })
})
