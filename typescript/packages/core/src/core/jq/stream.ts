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
import { JQ_EMPTY } from './format.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })
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

export function parseJsonAuto(raw: Uint8Array): unknown {
  const text = DEC.decode(raw).trim()
  if (text === '') throw new Error('jq: empty input')
  try {
    return parseSafe(text)
  } catch (err) {
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= 1) throw err
    return lines.map((line) => parseSafe(line))
  }
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
    const result = await jqEval(obj, perItem)
    if (result === JQ_EMPTY) continue
    const line = raw && typeof result === 'string' ? result : JSON.stringify(result)
    yield ENC.encode(line + '\n')
  }
}
