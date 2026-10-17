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

import { chunks } from '../../../../io/cooperative.ts'
import type { ByteSource } from '../../../../io/types.ts'
import type { BcStatement } from './types.ts'
import * as constants from './constants.ts'

export function stringEnd(text: string, pos: number): number {
  const close = text.indexOf(constants.STRING_QUOTE, pos + 1)
  return close < 0 ? -1 : close + 1
}

export function unescape(text: string): string {
  const out: string[] = []
  let pos = 0
  while (pos < text.length) {
    const char = text.charAt(pos)
    if (char !== '\\') {
      out.push(char)
      pos += 1
      continue
    }
    out.push(constants.PRINT_ESCAPES.get(text.charAt(pos + 1)) ?? '')
    pos += 2
  }
  return out.join('')
}
export function allBlank(text: string): boolean {
  for (const char of text) {
    if (!constants.TRIM_CHARS.includes(char)) return false
  }
  return true
}

export function trimPiece(text: string, lines: readonly number[]): [string, number[]] {
  let start = 0
  let end = text.length
  while (start < end && constants.TRIM_CHARS.includes(text.charAt(start))) start++
  while (end > start && constants.TRIM_CHARS.includes(text.charAt(end - 1))) end--
  return [text.slice(start, end), lines.slice(start, end)]
}

export function quitOffset(text: string): number {
  let pos = 0
  while (pos < text.length) {
    const char = text.charAt(pos)
    if (constants.NAME_START.has(char)) {
      const start = pos
      pos++
      while (pos < text.length && constants.NAME_CHARS.has(text.charAt(pos))) pos++
      if (text.slice(start, pos) === constants.QUIT_NAME) return start
    } else if (constants.NUMBER_CHARS.has(char)) {
      while (pos < text.length && constants.NUMBER_CHARS.has(text.charAt(pos))) pos++
    } else if (char === constants.STRING_QUOTE) {
      const end = stringEnd(text, pos)
      pos = end < 0 ? pos + 1 : end
    } else {
      pos++
    }
  }
  return -1
}

export function cutAtQuit(
  text: string,
  lines: readonly number[],
): [string, readonly number[], boolean] {
  const cut = quitOffset(text)
  if (cut < 0) return [text, lines, false]
  const before = text.slice(0, cut)
  const head = before.slice(before.lastIndexOf(constants.STATEMENT_SEPARATOR) + 1)
  const end = allBlank(head) ? cut : cut + constants.QUIT_NAME.length
  return [text.slice(0, end), lines.slice(0, end), true]
}

export function lineStatements(
  raw: string,
  rawLines: readonly number[],
  endLine: number,
): [BcStatement[], boolean] {
  const [text, lines, quits] = cutAtQuit(raw, rawLines)
  const out: BcStatement[] = []
  let start = 0
  let index = 0
  while (index <= text.length) {
    if (index < text.length) {
      const char = text.charAt(index)
      if (char === constants.STRING_QUOTE) {
        const end = stringEnd(text, index)
        index = end < 0 ? index + 1 : end
        continue
      }
      if (char !== constants.STATEMENT_SEPARATOR) {
        index++
        continue
      }
    }
    const [piece, pieceLines] = trimPiece(text.slice(start, index), lines.slice(start, index))
    if (piece !== '') {
      const incompleteLine = index < text.length ? (lines[index] ?? endLine) : endLine + 1
      out.push({ text: piece, lines: pieceLines, incompleteLine, execute: !quits })
    }
    start = index + 1
    index++
  }
  return [out, quits]
}

export async function* parseInput(
  source: ByteSource,
  signal?: AbortSignal,
): AsyncGenerator<BcStatement[] | string> {
  const stream = chunks(source, signal)
  const decoder = new TextDecoder()
  let text = ''
  let pos = 0
  let exhausted = false
  const refill = async (): Promise<void> => {
    const next = await stream.next()
    exhausted = next.done === true
    text += next.done === true ? decoder.decode() : decoder.decode(next.value, { stream: true })
  }
  const ended = (): boolean => exhausted
  const more = async (): Promise<boolean> => {
    while (pos >= text.length && !ended()) await refill()
    return pos < text.length
  }
  try {
    let chars: string[] = []
    let charLines: number[] = []
    let line = 1
    while (await more()) {
      const char = text.charAt(pos)
      if (char === constants.STRING_QUOTE) {
        let end = stringEnd(text, pos)
        while (end < 0 && !ended()) {
          await refill()
          end = stringEnd(text, pos)
        }
        if (end > 0) {
          for (let index = pos; index < end; index++) {
            const inner = text.charAt(index)
            chars.push(inner)
            charLines.push(line)
            if (inner === '\n') line++
          }
          pos = end
          continue
        }
      }
      if (char === constants.LINE_COMMENT) {
        while ((await more()) && text.charAt(pos) !== '\n') pos++
        continue
      }
      if (char === '/' && pos + 1 === text.length && !ended()) await refill()
      if (text.startsWith(constants.BLOCK_OPEN, pos)) {
        pos += constants.BLOCK_OPEN.length
        while (await more()) {
          if (text.charAt(pos) === '*' && pos + 1 === text.length && !ended()) await refill()
          if (text.startsWith(constants.BLOCK_CLOSE, pos)) break
          if (text.charAt(pos) === '\n') line++
          pos++
        }
        if (pos >= text.length) {
          yield constants.EOF_IN_COMMENT
          return
        }
        pos += constants.BLOCK_CLOSE.length
        chars.push(' ')
        charLines.push(line)
        continue
      }
      if (char === '\n') {
        const [found, quits] = lineStatements(chars.join(''), charLines, line)
        if (found.length > 0) yield found
        if (quits) return
        chars = []
        charLines = []
        line++
        text = text.slice(pos + 1)
        pos = 0
        continue
      }
      chars.push(char)
      charLines.push(line)
      pos++
    }
    const [found] = lineStatements(chars.join(''), charLines, line)
    if (found.length > 0) yield found
    return
  } finally {
    await stream.return?.()
  }
}
