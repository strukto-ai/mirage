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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })
const WHITESPACE = /\s/
const ENC = new TextEncoder()

function parseSafe(text: string): unknown {
  return JSON.parse(text) as unknown
}

function parseJsonl(raw: Uint8Array): unknown[] {
  const text = DEC.decode(raw)
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseSafe(line))
}

function documentEnd(text: string, start: number): number {
  const opener = text[start]
  if (opener !== '{' && opener !== '[') {
    if (opener !== '"') {
      let i = start
      while (i < text.length) {
        const ch = text[i]
        if (ch === undefined || WHITESPACE.test(ch)) break
        i += 1
      }
      return i
    }
    let i = start + 1
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') return i + 1
      i += 1
    }
    return text.length
  }
  let depth = 0
  let inStr = false
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i += 1
      else if (ch === '"') inStr = false
      i += 1
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return text.length
}

export function parseJsonDocs(raw: Uint8Array): unknown[] {
  const text = DEC.decode(raw).trim()
  if (text === '') throw new Error('jq: empty input')
  try {
    return [parseSafe(text)]
  } catch (singleDocError) {
    const docs: unknown[] = []
    let idx = 0
    while (idx < text.length) {
      const end = documentEnd(text, idx)
      if (end <= idx) throw singleDocError
      try {
        docs.push(parseSafe(text.slice(idx, end)))
      } catch {
        // Not a value stream either, so the input is simply invalid.
        // Re-throw the whole-document error: it names the real problem.
        throw singleDocError
      }
      idx = end
      while (idx < text.length) {
        const ch = text[idx]
        if (ch === undefined || !WHITESPACE.test(ch)) break
        idx += 1
      }
    }
    return docs
  }
}

export function parseJsonAuto(raw: Uint8Array): unknown {
  const docs = parseJsonDocs(raw)
  return docs.length === 1 ? docs[0] : docs
}

export function parseJsonPath(raw: Uint8Array, path: string): unknown {
  if (path.endsWith('.jsonl') || path.endsWith('.ndjson')) return parseJsonl(raw)
  return parseSafe(DEC.decode(raw))
}

export function isJsonlPath(path: string): boolean {
  return path.endsWith('.jsonl') || path.endsWith('.ndjson')
}

export function isStreamableJsonlExpr(expression: string): boolean {
  return expression.trim().startsWith('.[]')
}

export async function* evalJsonlStream(
  source: AsyncIterable<Uint8Array>,
  expression: string,
  raw = false,
): AsyncIterable<Uint8Array> {
  const { jqEval } = await import('./eval.ts')
  const expr = expression.trim()
  let perItem: string
  if (expr === '.[]') perItem = '.'
  else if (expr.startsWith('.[] | ')) perItem = expr.slice(6)
  else if (expr.startsWith('.[].')) perItem = expr.slice(3)
  else perItem = expr

  const iter = new AsyncLineIterator(source)
  for await (const lineBytes of iter) {
    const text = DEC.decode(lineBytes).trim()
    if (text === '') continue
    const obj: unknown = JSON.parse(text)
    for (const value of await jqEval(obj, perItem)) {
      const line = raw && typeof value === 'string' ? value : JSON.stringify(value)
      yield ENC.encode(line + '\n')
    }
  }
}
