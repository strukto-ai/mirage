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

import { displayWidth } from '../git/ref_format.ts'

const INDICATOR = '…'
const MIN_FREE_CHARS = 2
const PADDING = 2
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
const KIBI = 1024

export interface Cell {
  text: string
  right?: boolean
}

export interface Row {
  cells: readonly Cell[]
  maxHeight: number | null
}

/** One table cell. */
export function cell(text: string, right = false): Cell {
  return { text, right }
}

/** One table row, cut to one line unless told otherwise. */
export function row(cells: readonly Cell[], maxHeight: number | null = 1): Row {
  return { cells, maxHeight }
}

/** A byte count in binary units, as the SIZE columns show it. */
export function formatSize(size: number): string {
  let value = size
  let scale = 0
  while (Math.abs(value) >= KIBI) {
    value /= KIBI
    scale += 1
  }
  const places = Number.isInteger(value) ? 0 : 2
  return `${value.toFixed(places)} ${SIZE_UNITS[scale]!}`
}

function splitLongWord(allowed: number, word: string): [string, string] {
  const chars = [...word]
  let taken = 0
  for (let index = 0; index < chars.length; index += 1) {
    taken += displayWidth(chars[index]!)
    if (taken > allowed) return [chars.slice(0, index).join(''), chars.slice(index).join('')]
  }
  return [word, '']
}

function flushed(lines: string[], width: number, line: string, length: number): [string, number] {
  if (length > Math.max(width - MIN_FREE_CHARS, 0)) {
    lines.push(line)
    return ['', 0]
  }
  return [line, length]
}

/** Wrap one line of a cell to the column's content width. */
export function splitLine(line: string, width: number): string[] {
  const lines: string[] = []
  const words = line.split(' ')
  words.reverse()
  let current = ''
  let length = 0
  while (words.length > 0) {
    const word = words.pop()!
    const wordLength = displayWidth(word)
    const added = wordLength + length + (current !== '' ? 1 : 0)
    let remaining = width - length
    if (current !== '') remaining = Math.max(remaining - 1, 0)
    if (added <= width) {
      if (current !== '') {
        current += ' '
        length += 1
      }
      current += word
      length += wordLength
      ;[current, length] = flushed(lines, width, current, length)
      continue
    }
    if (current !== '' && remaining <= MIN_FREE_CHARS) {
      words.push(word)
      lines.push(current)
      current = ''
      length = 0
      continue
    }
    if (wordLength > width) {
      const fresh = current === ''
      if (!fresh) current += ' '
      const [head, tail] = splitLongWord(remaining, word)
      if (fresh && head === '') {
        const chars = [...tail]
        current += chars[0]!
        words.push(chars.slice(1).join(''))
      } else {
        current += head
        words.push(tail)
      }
      lines.push(current)
      current = ''
      length = 0
      continue
    }
    lines.push(current)
    current = word
    length = wordLength
    ;[current, length] = flushed(lines, width, current, length)
  }
  if (current !== '') lines.push(current)
  return lines
}

function contentLines(one: Cell): string[] {
  return one.text.split('\n')
}

function longestAfterSplit(average: number, column: number, rows: readonly Row[]): number {
  let longest = 0
  for (const entry of rows) {
    const one = entry.cells[column]
    if (one === undefined) continue
    for (const line of contentLines(one)) {
      if (displayWidth(line) > average) {
        for (const part of splitLine(line, average)) longest = Math.max(longest, displayWidth(part))
      } else {
        longest = Math.max(longest, displayWidth(line))
      }
    }
  }
  return longest
}

/** The content width of every column. */
export function arrangedWidths(
  rows: readonly Row[],
  fitted: ReadonlySet<number>,
  maxWidth: number | null,
): number[] {
  const count = rows[0]!.cells.length
  const natural: number[] = []
  for (let column = 0; column < count; column += 1) {
    let widest = 0
    for (const entry of rows) {
      const one = entry.cells[column]
      if (one === undefined) continue
      for (const line of contentLines(one)) widest = Math.max(widest, displayWidth(line))
    }
    natural.push(widest)
  }
  if (maxWidth === null) return natural
  const decided = new Map<number, number>()
  for (const column of fitted) decided.set(column, natural[column]!)
  let remainingWidth = Math.max(maxWidth - (count + 1), 0)
  for (let column = 0; column < count; column += 1) {
    const taken = decided.has(column) ? decided.get(column)! + PADDING : PADDING
    remainingWidth = Math.max(remainingWidth - taken, 0)
  }
  let remainingColumns = count - decided.size
  const fix = (column: number, width: number): void => {
    decided.set(column, width)
    remainingWidth = Math.max(remainingWidth - width, 0)
    remainingColumns -= 1
  }
  const average = (): number => Math.floor(remainingWidth / remainingColumns)
  let found = true
  while (found && remainingColumns > 0) {
    found = false
    if (average() === 0) break
    for (let column = 0; column < count; column += 1) {
      if (decided.has(column)) continue
      if (natural[column]! <= average()) {
        fix(column, natural[column]!)
        found = true
        if (remainingColumns === 0) break
      }
    }
  }
  found = remainingColumns > 0
  while (found && remainingColumns > 0) {
    found = false
    for (let column = 0; column < count; column += 1) {
      if (decided.has(column) || remainingColumns === 0) continue
      const space = average()
      const longest = longestAfterSplit(space, column, rows)
      if (Math.max(space - longest, 0) >= 3) {
        fix(column, longest)
        found = true
      }
    }
  }
  if (remainingColumns === 0) return natural.map((_, column) => decided.get(column)!)
  remainingWidth = Math.max(remainingWidth, remainingColumns)
  const even = Math.floor(remainingWidth / remainingColumns)
  let excess = remainingWidth - even * remainingColumns
  for (let column = 0; column < count; column += 1) {
    if (decided.has(column)) continue
    decided.set(column, even + (excess > 0 ? 1 : 0))
    excess -= 1
  }
  return natural.map((_, column) => decided.get(column)!)
}

function truncated(line: string, width: number): string {
  const indicator = displayWidth(INDICATOR) > width ? '' : INDICATOR
  let length = displayWidth(indicator)
  let cut = 0
  let fits = false
  const chars = [...line]
  for (let index = 0; index < chars.length; index += 1) {
    cut = index
    const wider = length + displayWidth(chars[index]!)
    if (wider > width) break
    length = wider
    if (index === chars.length - 1) fits = true
  }
  return (fits ? line : chars.slice(0, cut).join('')) + indicator
}

function cellLines(one: Cell, width: number, maxHeight: number | null): string[] {
  const lines: string[] = []
  for (const line of contentLines(one)) {
    if (displayWidth(line) > width) lines.push(...splitLine(line, width))
    else lines.push(line)
  }
  if (maxHeight !== null && lines.length > maxHeight) {
    lines.length = maxHeight
    lines[lines.length - 1] = truncated(lines[lines.length - 1]!, width)
  }
  return lines.map((line) => {
    const gap = ' '.repeat(Math.max(width - displayWidth(line), 0))
    return one.right === true ? ` ${gap}${line} ` : ` ${line}${gap} `
  })
}

function renderRow(entry: Row, widths: readonly number[]): string[] {
  const columns = entry.cells.map((one, index) => cellLines(one, widths[index]!, entry.maxHeight))
  const height = columns.reduce((widest, lines) => Math.max(widest, lines.length), 0)
  const out: string[] = []
  for (let index = 0; index < height; index += 1) {
    const fields = columns.map(
      (lines, column) => lines[index] ?? ' '.repeat(widths[column]! + PADDING),
    )
    out.push(`│${fields.join('┆')}│`)
  }
  return out
}

/** A table in the condensed box style, without a trailing newline. */
export function renderTable(
  header: Row,
  rows: readonly Row[],
  maxWidth: number | null = null,
  fitted: ReadonlySet<number> = new Set(),
): string {
  const widths = arrangedWidths([header, ...rows], fitted, maxWidth)
  const rules = widths.map((width) => '─'.repeat(width + PADDING))
  const thick = widths.map((width) => '═'.repeat(width + PADDING))
  const lines = [`┌${rules.join('┬')}┐`, ...renderRow(header, widths), `╞${thick.join('╪')}╡`]
  for (const entry of rows) lines.push(...renderRow(entry, widths))
  lines.push(`└${rules.join('┴')}┘`)
  return lines.join('\n')
}
