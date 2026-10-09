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

import { COMMENT_PRECEDERS, QUOTE_OPENERS } from './constants.ts'
import { cleanDelimiter, delimiterQuoted } from './delimiter.ts'
import { constructCloser, constructEnd, endsEscaped, operatorLineEnd, quoteEnd } from './line.ts'
import type { BodyRead, Heredoc, HeredocOperator, HeredocPlan } from './types.ts'

export function delimiterEnd(text: string, start: number): number | null {
  let index = start
  while (index < text.length) {
    const char = text[index] ?? ''
    const closer = char === '$' ? constructCloser(text, index, false) : null
    if (char === '\\') index += Math.min(2, text.length - index)
    else if (QUOTE_OPENERS.has(char)) {
      const end = quoteEnd(text, index)
      if (end === null) return null
      index = end
    } else if (closer !== null) {
      const end = constructEnd(text, index, closer)
      if (end === null) return null
      index = end
    } else if (COMMENT_PRECEDERS.has(char)) break
    else index += 1
  }
  return index
}

export function readBody(
  text: string,
  start: number,
  delimiter: string,
  quoted: boolean,
  dash: boolean,
): BodyRead {
  let body = ''
  const offsets: number[] = []
  let position = start
  let eofLine = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  while (position < text.length) {
    let line = ''
    const places: number[] = []
    let continued = false
    while (position < text.length) {
      const newline = text.indexOf('\n', position)
      const end = newline < 0 ? text.length : newline
      const begin = position
      line += text.slice(begin, end)
      for (let i = begin; i < end; i += 1) places.push(i)
      position = newline < 0 ? text.length : newline + 1
      continued = !quoted && endsEscaped(line) && newline >= 0
      if (continued) {
        line = line.slice(0, -1)
        places.pop()
        continue
      }
      break
    }
    if (continued && line === '') break
    if (dash) {
      let tabs = 0
      while (line[tabs] === '\t') tabs += 1
      line = line.slice(tabs)
      places.splice(0, tabs)
    }
    if (line === delimiter) return { body, offsets, end: position, terminated: true, eofLine }
    if (continued) eofLine += 1
    body += line + '\n'
    offsets.push(...places, Math.min(position - 1, text.length))
  }
  return { body, offsets, end: position, terminated: false, eofLine }
}

export function readHeredocs(text: string, operators: HeredocOperator[]): Heredoc[] {
  const documents: Heredoc[] = []
  let previousLine = -1
  let cursor = 0
  for (const operator of operators) {
    if (
      documents.some((doc) => doc.bodyStart <= operator.wordStart && operator.wordStart < doc.end)
    )
      continue
    const end = delimiterEnd(text, operator.wordStart)
    if (end === null) continue
    const token = text.slice(operator.wordStart, end)
    const delimiter = cleanDelimiter(token)
    const quoted = delimiterQuoted(token)
    const lineEnd = operatorLineEnd(text, end) ?? text.length
    const start = lineEnd === previousLine ? cursor : Math.min(lineEnd + 1, text.length)
    const result = readBody(text, start, delimiter, quoted, operator.allowsIndent)
    cursor = result.end
    let line =
      lineEnd === previousLine
        ? text.slice(0, Math.max(0, start - 1)).split('\n').length
        : text.slice(0, end).split('\n').length
    const previous = documents.at(-1)
    if (lineEnd === previousLine && previous !== undefined && !previous.terminated)
      line = previous.eofLine
    const eofLine = Math.max(result.eofLine, line)
    previousLine = lineEnd
    let opStart = operator.wordStart
    while (opStart > 0 && [' ', '\t'].includes(text[opStart - 1] ?? '')) opStart -= 1
    opStart -= operator.allowsIndent ? 3 : 2
    documents.push({
      operatorStart: opStart,
      wordEnd: end,
      delimiter,
      quoted,
      bodyStart: start,
      end: cursor,
      body: result.body,
      offsets: result.offsets,
      terminated: result.terminated,
      line,
      eofLine,
    })
  }
  return documents
}

/** Read the bodies the syntax reader found, where it found them and in its
 * order, which is bash's. A body the reader ended at a substitution's `)`
 * after its delimiter holds the lines before that one. */
export function readPlanned(text: string, plan: HeredocPlan): Heredoc[] {
  const documents: Heredoc[] = []
  for (const [at, start, end] of plan.order) {
    const dash = text.charAt(at + 2) === '-'
    let word = at + (dash ? 3 : 2)
    while (text.charAt(word) === ' ' || text.charAt(word) === '\t' || text.startsWith('\\\n', word))
      word += text.charAt(word) === '\\' ? 2 : 1
    const wordEnd = delimiterEnd(text, word)
    if (wordEnd === null) continue
    const token = text.slice(word, wordEnd)
    const delimiter = cleanDelimiter(token)
    const quoted = delimiterQuoted(token)
    let result = readBody(text, start, delimiter, quoted, dash)
    if (result.end > end) {
      const cut = text.lastIndexOf('\n', end - 1) + 1
      result = {
        ...readBody(text.slice(0, cut), start, delimiter, quoted, dash),
        end,
        terminated: true,
      }
    }
    const previous = documents.at(-1)
    let line = text.slice(0, wordEnd).split('\n').length
    if (previous?.end === start)
      line = previous.terminated
        ? text.slice(0, Math.max(0, start - 1)).split('\n').length
        : previous.eofLine
    documents.push({
      operatorStart: at,
      wordEnd,
      delimiter,
      quoted,
      bodyStart: start,
      end: result.end,
      body: result.body,
      offsets: result.offsets,
      terminated: result.terminated,
      line,
      eofLine: Math.max(result.eofLine, line),
    })
  }
  return documents
}

export function discoverHeredocs(text: string, hints: HeredocOperator[]): Heredoc[] {
  const operators = [...hints]
  let documents = readHeredocs(text, operators)
  let index = 0
  while (index < text.length) {
    const containing = documents.find((doc) => doc.bodyStart <= index && index < doc.end)
    if (containing !== undefined) {
      index = containing.end
      continue
    }
    const char = text[index] ?? ''
    if (text.slice(index, index + 2) === '${') index = constructEnd(text, index, '}') ?? text.length
    else if (text.slice(index, index + 2) === '$[')
      index = constructEnd(text, index, ']') ?? text.length
    else if (text.slice(index, index + 2) === '((')
      index = constructEnd(text, index, ')') ?? text.length
    else if (char === '\\') index += 2
    else if (QUOTE_OPENERS.has(char)) index = quoteEnd(text, index) ?? text.length
    else if (char === '#' && (index === 0 || COMMENT_PRECEDERS.has(text[index - 1] ?? ''))) {
      const newline = text.indexOf('\n', index)
      index = newline < 0 ? text.length : newline
    } else if (text.slice(index, index + 3) === '<<<') index += 3
    else if (text.slice(index, index + 2) === '<<') {
      const dash = text[index + 2] === '-'
      let start = index + (dash ? 3 : 2)
      while (start < text.length && [' ', '\t'].includes(text[start] ?? '')) start += 1
      const end = delimiterEnd(text, start)
      if (end === null) break
      if (end === start) {
        index += 2
        continue
      }
      if (!operators.some((op) => op.wordStart === start)) {
        operators.push({
          wordStart: start,
          wordEnd: end,
          delimiter: cleanDelimiter(text.slice(start, end)),
          allowsIndent: dash,
        })
        operators.sort((a, b) => a.wordStart - b.wordStart)
        documents = readHeredocs(text, operators)
      }
      index = end
    } else index += 1
  }
  return documents
}
