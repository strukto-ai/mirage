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

import { constructCloser, constructEnd, quoteEnd } from './line.ts'
import type { Heredoc, HeredocSource } from './types.ts'

export function quotedBody(doc: Heredoc): [string, number[]] {
  let out = '"'
  const offsets = [doc.bodyStart]
  let index = 0
  while (index < doc.body.length) {
    const char = doc.body[index] ?? ''
    let end: number | null = null
    if (!doc.quoted) {
      const closer = char === '$' ? constructCloser(doc.body, index, false) : null
      if (closer !== null) end = constructEnd(doc.body, index, closer)
      else if (char === '`') end = quoteEnd(doc.body, index)
      else if (char === '\\' && ['$', '`', '\\'].includes(doc.body[index + 1] ?? ''))
        end = index + 2
    }
    if (end !== null) {
      out += doc.body.slice(index, end)
      offsets.push(...doc.offsets.slice(index, end))
      index = end
      continue
    }
    if (['"', '\\'].includes(char) || (doc.quoted && ['$', '`'].includes(char))) {
      out += '\\'
      offsets.push(doc.offsets[index] ?? doc.end)
    }
    out += char
    offsets.push(doc.offsets[index] ?? doc.end)
    index += 1
  }
  out += '"'
  offsets.push(doc.end)
  return [out, offsets]
}

export function lowerHeredocs(text: string, documents: Heredoc[]): HeredocSource {
  const edits: [number, number, string, number[], Heredoc | null][] = []
  for (const doc of documents) {
    const [word, positions] = quotedBody(doc)
    edits.push([doc.operatorStart, doc.wordEnd, '<' + word, [doc.operatorStart, ...positions], doc])
    if (doc.end > doc.bodyStart) edits.push([doc.bodyStart, doc.end, '', [], null])
  }
  let out = ''
  const offsets: number[] = []
  const attached: [number, Heredoc][] = []
  let cursor = 0
  for (const [start, end, replacement, positions, doc] of edits.sort((a, b) => a[0] - b[0])) {
    out += text.slice(cursor, start)
    for (let i = cursor; i < start; i += 1) offsets.push(i)
    if (doc !== null) attached.push([out.length, doc])
    out += replacement
    offsets.push(...positions)
    cursor = end
  }
  out += text.slice(cursor)
  for (let i = cursor; i <= text.length; i += 1) offsets.push(i)
  return { original: text, source: out, offsets, documents: attached }
}

export function rebaseSource(source: HeredocSource, repaired: string): HeredocSource {
  if (repaired === source.source) return source
  const offsets: number[] = []
  const starts = new Map<number, number>()
  let cursor = 0
  for (let index = 0; index < repaired.length; index += 1) {
    offsets.push(source.offsets[cursor] ?? source.original.length)
    if (cursor < source.source.length && repaired[index] === source.source[cursor]) {
      starts.set(cursor, index)
      cursor += 1
    }
  }
  if (cursor !== source.source.length)
    throw new Error('shell repair must preserve the lowered source')
  offsets.push(source.original.length)
  return {
    ...source,
    source: repaired,
    offsets,
    documents: source.documents.map(([start, doc]) => [starts.get(start) ?? start, doc]),
  }
}
