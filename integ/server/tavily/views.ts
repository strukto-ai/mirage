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

import type { JsonValue } from '../kit/typescript/index.ts'

export interface RuleRow {
  id: string
  keywords: string
  answer: string | null
  status: number | null
  error: string | null
}

export interface HitRow {
  title: string
  url: string
  content: string
  rawContent: string | null
  score: number
}

export interface ImageRow {
  url: string
  description: string | null
}

export interface PageRow {
  url: string
  site: string
  rawContent: string
}

export interface ResearchRow {
  id: string
  keywords: string
  status: string
  content: string | null
  error: string | null
  steps: string | null
  createdAt: string
}

export interface SourceRow {
  title: string
  url: string
}

// Every answer carries a fixed time and id, so a golden that prints the
// whole body (--json) is the same on every run.
export const RESPONSE_TIME = 0.42

// A request option as the API reads it: the SDK sends a boolean or the mode
// name, and false or absence turns the feature off.
export function asked(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== false && value !== 'false'
}

export function errorBody(message: string): JsonValue {
  return { detail: { error: message } }
}

export function hitJson(hit: HitRow, raw: boolean): JsonValue {
  return {
    url: hit.url,
    title: hit.title,
    content: hit.content,
    score: hit.score,
    raw_content: raw ? hit.rawContent : null,
  }
}

export function imageJson(image: ImageRow, described: boolean): JsonValue {
  return described ? { url: image.url, description: image.description } : image.url
}

export function sourceJson(source: SourceRow): JsonValue {
  return { title: source.title, url: source.url }
}

// The host a start url names; the API takes a bare host too, as tvly sends
// what the user typed.
export function siteOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname
  } catch {
    return ''
  }
}

// One OpenAI-style chunk, the shape the research stream sends.
export function chunk(delta: Record<string, JsonValue>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

// A stored step line, `call|<tool>|<arguments>` or `response|<tool>|<count>`,
// as the stream's tool event.
export function stepDelta(line: string, sources: SourceRow[]): Record<string, JsonValue> {
  const [kind, name, detail] = line.split('|')
  if (kind === 'response') {
    const count = Number(detail ?? '0')
    return {
      tool_calls: {
        type: 'tool_response',
        tool_response: [{ name: name ?? '', sources: sources.slice(0, count).map(sourceJson) }],
      },
    }
  }
  const call: Record<string, JsonValue> = { name: name ?? '' }
  if (detail !== undefined && detail !== '') call.arguments = detail
  return { tool_calls: { type: 'tool_call', tool_call: [call] } }
}

// The report in two pieces split at the space nearest its middle, so a
// client has to join the deltas to print it.
export function contentPieces(content: string): string[] {
  const middle = content.indexOf(' ', Math.floor(content.length / 2))
  if (middle < 0) return [content]
  return [content.slice(0, middle), content.slice(middle)]
}
