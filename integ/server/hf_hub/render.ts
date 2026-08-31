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

// The markdown the Hugging Face MCP server answers with. Every shape here was
// captured from the live server (huggingface.co/mcp 0.4.15) rather than
// designed, for the same reason the tool document is captured rather than
// authored: the agent under measurement reads this text, so a rendering that
// is merely reasonable changes what is being measured. The captures are quoted
// above each renderer.
//
// What is NOT here is as deliberate. The live `hub_repo_details` also renders
// "Technical Details" (model class, parameter count, architecture), "Demo
// Spaces" and "Inference Providers", and all three come from data the hf_hub
// fake has no column for. Rendering them from nothing would be inventing facts
// about a repository, which is worse than a shorter answer, so those sections
// are absent rather than empty.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2 Mar, 2022", the live server's date column. The day is not zero-padded. */
export function humanDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}, ${String(at.getUTCFullYear())}`
}

// Downloads abbreviate and likes do not, which is the live server's own split:
// it renders "Downloads: 3197.6M" rather than moving to a G tier, so there is
// no third step here either.
export function humanCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Binary units with one decimal, and BYTES spelled out below 1 KiB
// ("570 bytes", "1.6 KB", "4.6 GB").
export function humanSize(n: number): string {
  if (n < 1024) return `${String(n)} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let at = 0
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024
    at += 1
  }
  return `${value.toFixed(1)} ${units[at] ?? 'KB'}`
}

// A table cell is markdown, and a Hub path is full of underscores
// (`chat_template.jinja`), which italicise in pairs. The set is NARROW, and
// the capture is why: the live server renders `chat\_template.jinja` but
// `.gitattributes` and `model-00000-of-00014.safetensors` unescaped, so a
// general markdown escaper is wrong here -- it would put a backslash in front
// of every dot and hyphen in a Hub listing. `|` is escaped for a reason the
// capture cannot show, since no upstream filename contained one: an unescaped
// pipe ends the table cell.
export function escapeCell(s: string): string {
  return s.replace(/([\\`*_|])/g, '\\$1')
}

const MAX_TAGS = 20

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function strList(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.map((one) => String(one)) : []
}

function str(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: JsonValue | undefined): number {
  return typeof v === 'number' ? v : 0
}

// The plural section heading the live server uses per repo type.
const SECTION: Record<string, string> = {
  models: 'Models',
  datasets: 'Datasets',
  spaces: 'Spaces',
}

/**
 * One repository block inside a search result.
 *
 * Captured (google-bert/bert-base-uncased, trimmed):
 *
 *   ### google-bert/bert-base-uncased
 *
 *   **Task:** fill-mask | **Library:** transformers | **Downloads:** 81.2M | ...
 *
 *   **Tags:** transformers, pytorch, ...
 *   *and 97 more...*
 *
 *   **Created:** 2 Mar, 2022
 *   **Link:** [https://hf.co/google-bert/bert-base-uncased](https://hf.co/...)
 */
function searchBlock(row: Record<string, JsonValue>): string {
  const id = str(row.id)
  const facts: string[] = []
  const task = str(row.pipeline_tag)
  const library = str(row.library_name)
  if (task !== '') facts.push(`**Task:** ${task}`)
  if (library !== '') facts.push(`**Library:** ${library}`)
  facts.push(`**Downloads:** ${humanCount(num(row.downloads))}`)
  facts.push(`**Likes:** ${String(num(row.likes))}`)
  facts.push(`**Trending Score:** ${String(num(row.trendingScore))}`)
  const tags = strList(row.tags)
  const shown = tags.slice(0, MAX_TAGS)
  const lines = [`### ${id}`, '', facts.join(' | '), '']
  if (shown.length > 0) {
    lines.push(`**Tags:** ${shown.join(', ')}`)
    if (tags.length > shown.length)
      lines.push(`*and ${String(tags.length - shown.length)} more...*`)
    lines.push('')
  }
  lines.push(`**Created:** ${humanDate(str(row.createdAt))}`)
  lines.push(`**Link:** [https://hf.co/${id}](https://hf.co/${id})`)
  lines.push('', '---', '')
  return lines.join('\n')
}

export function searchMarkdown(
  query: string,
  found: { kind: string; rows: Record<string, JsonValue>[] }[],
): string {
  const total = found.reduce((n, one) => n + one.rows.length, 0)
  const kinds = found.map((one) => one.kind).join(', ')
  const head =
    query === ''
      ? `Found ${String(total)} repositories across ${kinds}.`
      : `Found ${String(total)} repositories across ${kinds} matching query "${query}".`
  const parts = [head, '']
  for (const one of found) {
    parts.push(`## ${SECTION[one.kind] ?? one.kind} (${String(one.rows.length)})`, '')
    for (const row of one.rows) parts.push(searchBlock(row))
  }
  return parts.join('\n')
}

const TYPE_WORD: Record<string, string> = {
  models: 'Model',
  datasets: 'Dataset',
  spaces: 'Space',
}

/**
 * A repository's overview.
 *
 * Captured (google-bert/bert-base-uncased, trimmed):
 *
 *   **Type: Model**
 *
 *   # google-bert/bert-base-uncased
 *
 *   ## Overview
 *   - **Author:** google-bert
 *   ...
 *   ## Tags
 *   `transformers` `pytorch` ...
 *
 *   ## Metadata
 *   - **Language:** en
 */
export function detailsMarkdown(kind: string, body: Record<string, JsonValue>): string {
  const id = str(body.id)
  const card = obj(body.cardData)
  const out = [`**Type: ${TYPE_WORD[kind] ?? kind}**`, '', `# ${id}`, '', '## Overview']
  out.push(`- **Author:** ${str(body.author)}`)
  const task = str(body.pipeline_tag)
  const library = str(body.library_name)
  if (task !== '') out.push(`- **Task:** ${task}`)
  if (library !== '') out.push(`- **Library:** ${library}`)
  out.push(
    `- **Downloads:** ${humanCount(num(body.downloads))} | **Likes:** ${String(num(body.likes))}`,
  )
  out.push(`- **Updated:** ${humanDate(str(body.lastModified))}`)
  const tags = strList(body.tags)
  if (tags.length > 0) {
    out.push('', '## Tags', tags.map((t) => `\`${t}\``).join(' '))
  }
  const meta: string[] = []
  const language = card.language
  const languages = typeof language === 'string' ? [language] : strList(language)
  if (languages.length > 0) meta.push(`- **Language:** ${languages.join(', ')}`)
  const license = str(card.license)
  if (license !== '') meta.push(`- **License:** ${license}`)
  const datasets = strList(card.datasets)
  if (datasets.length > 0) meta.push(`- **Datasets:** ${datasets.join(', ')}`)
  if (meta.length > 0) out.push('', '## Metadata', ...meta)
  const files = Array.isArray(body.siblings) ? body.siblings.length : 0
  if (files > 0)
    out.push('', `## Files`, `- ${String(files)} files at revision \`${str(body.sha)}\``)
  out.push('', `**Link:** [https://hf.co/${id}](https://hf.co/${id})`)
  return out.join('\n')
}

// ------------------------------------------------------------------- hf_fs

export interface FsEntry {
  type: string
  path: string
  size: number
  lfs: boolean
}

/**
 * An `ls` or `find` listing.
 *
 * Captured:
 *
 *   # hf_fs ls
 *
 *   URI: `hf://models/openai/gpt-oss-120b`
 *
 *   | Type | Path | URI | Target | Details |
 *   |---|---|---|---|---|
 *   | dir | metal |  |  |  |
 *   | file | README.md |  |  | size=7.1 KB |
 *   | file | model-00000-of-00014.safetensors |  |  | lfs, size=4.6 GB |
 *
 * The URI and Target columns are blank for an ordinary Hub listing; they carry
 * a value only for the entry kinds this fake has none of, so they are rendered
 * empty rather than dropped -- the column count is part of what was captured.
 */
export function listingMarkdown(cmd: string, uri: string, rows: FsEntry[]): string {
  const out = [`# hf_fs ${cmd}`, '', `URI: \`${uri}\``, '']
  out.push('| Type | Path | URI | Target | Details |', '|---|---|---|---|---|')
  for (const row of rows) {
    const details = row.type === 'dir' ? '' : `${row.lfs ? 'lfs, ' : ''}size=${humanSize(row.size)}`
    out.push(`| ${row.type} | ${escapeCell(row.path)} |  |  | ${details} |`)
  }
  return out.join('\n')
}

/**
 * Captured:
 *
 *   # hf_fs stat
 *
 *   - URI: `hf://models/google-bert/bert-base-uncased/config.json`
 *   - Exists: yes
 *   - Type: `file`
 *   - Path: `config.json`
 *   - Size: 570 bytes
 */
export function statMarkdown(uri: string, entry: FsEntry | null, path: string): string {
  const out = [`# hf_fs stat`, '', `- URI: \`${uri}\``]
  if (entry === null) {
    out.push('- Exists: no')
    return out.join('\n')
  }
  out.push('- Exists: yes', `- Type: \`${entry.type === 'dir' ? 'dir' : 'file'}\``)
  out.push(`- Path: \`${path}\``)
  if (entry.type !== 'dir') out.push(`- Size: ${humanSize(entry.size)}`)
  return out.join('\n')
}

/**
 * Captured:
 *
 *   # hf_fs cat
 *
 *   URI: `hf://models/google-bert/bert-base-uncased/config.json`
 *   Path: `config.json`
 *   Bytes: 570
 *
 *   {content}
 */
export function catMarkdown(uri: string, path: string, content: Uint8Array): string {
  const text = Buffer.from(content).toString('utf8')
  return [
    `# hf_fs cat`,
    '',
    `URI: \`${uri}\``,
    `Path: \`${path}\``,
    `Bytes: ${String(content.length)}`,
    '',
    text,
  ].join('\n')
}

// The live server's own error envelope: a bracketed code, a message, then a
// `Recovery:` line. Both codes here were captured; NEITHER is invented, which
// matters because an agent may branch on the code.
export const FS_NOT_FOUND = 'HF_FS_NOT_FOUND'
export const FS_INVALID = 'HF_FS_INVALID_ARGUMENT'

const RECOVERY: Record<string, string> = {
  [FS_NOT_FOUND]:
    'Use stat to verify the target or ls/find to discover a returned URI before retrying.',
  [FS_INVALID]:
    'Correct the URI or flags using the operation grammar and route-specific option guidance.',
}

export function fsRecovery(code: string): string {
  return RECOVERY[code] ?? ''
}

export function fsError(code: string, message: string): string {
  const recovery = fsRecovery(code)
  return recovery === '' ? `[${code}] ${message}` : `[${code}] ${message}\nRecovery: ${recovery}`
}

// Operations are numbered and separated by a rule, which is how the live server
// answers a batch and how a client tells one operation's output from the next.
export function operationsMarkdown(parts: string[]): string {
  return parts.map((one, i) => `## Operation ${String(i + 1)}\n\n${one}\n`).join('\n---\n\n')
}
