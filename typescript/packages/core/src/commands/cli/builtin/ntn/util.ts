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

import { HttpNotionTransport } from '../../../../core/notion/client.ts'
import type { NotionConfig } from '../../../../core/notion/config.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()
const CHECKED = '✓'

export function notionTransport(
  config: unknown,
  flags?: Record<string, string | boolean | number | string[]>,
): HttpNotionTransport {
  const cfg = config as NotionConfig
  // --notion-version is upstream's per-invocation override of the header, and
  // the executor has already filled it from NOTION_API_VERSION when the line
  // omitted it, so a verb reads one flag and never the environment. Every verb
  // passes its flags here rather than building a transport of its own, or the
  // override would work on whichever verbs remembered it.
  const flagVersion = flags === undefined ? undefined : new FlagView(flags).asStr('notion_version')
  // An empty flag falls back to the config's own pin, exactly as python's
  // `notion_config` returns `inv.config` untouched for an empty --notion-version.
  const version = flagVersion !== undefined && flagVersion !== '' ? flagVersion : cfg.apiVersion
  return new HttpNotionTransport({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl !== undefined && cfg.baseUrl !== '' ? { baseUrl: cfg.baseUrl } : {}),
    ...(version !== undefined && version !== '' ? { apiVersion: version } : {}),
  })
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort(compareCodePoints)) out[key] = sortDeep(source[key])
  return out
}

// Two spaces of indent and keys in sorted order, matching the upstream
// binary's serializer, so a golden recorded from the real CLI compares byte
// for byte. JSON.stringify keeps insertion order, so the sort is explicit.
export function prettyJson(value: unknown): ByteSource {
  return ENC.encode(`${JSON.stringify(sortDeep(value), null, 2)}\n`)
}

// What `ntn api` prints: one line, no spaces, same sorted keys.
export function compactJson(value: unknown): ByteSource {
  return ENC.encode(`${JSON.stringify(sortDeep(value))}\n`)
}

// Quote a string the way Rust's `{:?}` renders one. `ntn` interpolates the
// offending token into its parse errors with the Debug formatter, so a token
// carrying a quote, a backslash or a tab comes back escaped. Non-ASCII is
// left alone, which is why an accented character appears verbatim in the real
// binary's message.
export function rustDebug(text: string): string {
  let out = '"'
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"' || char === '\\') out += `\\${char}`
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`
    else out += char
  }
  return `${out}"`
}

export function firstText(texts: readonly string[], what: string): string {
  const head = texts[0]
  if (head === undefined || head === '') throw new Error(`${what} is required`)
  return head
}

// The upstream CLI's third content source is $EDITOR, which a virtualized CLI
// has no terminal for, so the two non-interactive sources are the whole
// surface here.
export async function contentOrStdin(
  inline: string | undefined,
  stdin: ByteSource | null | undefined,
): Promise<string> {
  if (inline !== undefined) return inline
  if (stdin === null || stdin === undefined) {
    throw new Error('provide Markdown with --content or on stdin')
  }
  if (stdin instanceof Uint8Array) return new TextDecoder().decode(stdin)
  const chunks: Uint8Array[] = []
  for await (const chunk of stdin) chunks.push(chunk)
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder().decode(joined)
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function plainTextOf(fragments: unknown): string {
  if (!Array.isArray(fragments)) return ''
  let out = ''
  for (const fragment of fragments) {
    const text = asObject(fragment).plain_text
    if (typeof text === 'string') out += text
  }
  return out
}

function strOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function namesOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map((one) => strOf(asObject(one), 'name')).join(', ')
}

// The formats are pinned against the real binary: a checked box is a check
// mark and an unchecked one is empty, a date shows its start, a multi-select
// joins with a comma and a space, and anything unset is the empty string.
export function propertyCell(prop: unknown): string {
  const record = asObject(prop)
  const kind = record.type
  if (typeof kind !== 'string') return ''
  const value = record[kind]
  if (kind === 'title' || kind === 'rich_text') return plainTextOf(value)
  if (kind === 'checkbox') return value === true ? CHECKED : ''
  if (kind === 'number') return typeof value === 'number' ? String(value) : ''
  if (kind === 'select' || kind === 'status') {
    return value === null ? '' : strOf(asObject(value), 'name')
  }
  if (kind === 'multi_select' || kind === 'people') return namesOf(value)
  if (kind === 'date') return value === null ? '' : strOf(asObject(value), 'start')
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

export function parseJsonText(text: string, flag: string): Record<string, unknown> {
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // One wording in both languages: the engines' own parse messages
    // ("Expecting value" vs "Unexpected token") can never agree.
    throw new Error(`${flag} must be valid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function parseJsonFlag(value: unknown, flag: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new Error(`${flag} must be a JSON string`)
  return parseJsonText(value, flag)
}

export function usageError(err: unknown): CommandFnResult {
  const msg = err instanceof Error ? err.message : String(err)
  return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
}
