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
// What upstream says when a listing stopped at the entry limit, and it says
// it after the table rather than in the header -- the same placement as
// cat's resume notice.
export const LIST_TRUNCATED =
  'Result truncated after reaching the entry limit. Rerun with a larger --limit, up to 10000.'

export function listingMarkdown(
  cmd: string,
  uri: string,
  rows: FsEntry[],
  truncated = false,
): string {
  const out = [`# hf_fs ${cmd}`, '', `URI: \`${uri}\``, '']
  out.push('| Type | Path | URI | Target | Details |', '|---|---|---|---|---|')
  for (const row of rows) {
    const details = row.type === 'dir' ? '' : `${row.lfs ? 'lfs, ' : ''}size=${humanSize(row.size)}`
    out.push(`| ${row.type} | ${escapeCell(row.path)} |  |  | ${details} |`)
  }
  if (truncated) out.push('', LIST_TRUNCATED)
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
// The four things a URI can be, which is one more than this renderer used to
// admit and one more than the fake used to compute. A repository is not a
// directory upstream, and a path that is not there is `missing` rather than an
// absent Type line -- both are printed, and both are printed for every
// outcome, so a reader never has to infer a field from its absence.
export type StatKind = 'file' | 'dir' | 'repo' | 'missing'

/**
 * Captured:
 *
 *   # hf_fs attach
 *
 *   - URI: `hf://datasets/OWNER/NAME/fig.png`
 *   - Path: `fig.png`
 *   - MIME type: `image/png`
 *   - Bytes: 2104615
 *
 * The bytes themselves ride beside this as an MCP image block, not in it.
 */
export function attachMarkdown(uri: string, path: string, mime: string, bytes: number): string {
  return [
    `# hf_fs attach`,
    '',
    `- URI: \`${uri}\``,
    `- Path: \`${path}\``,
    `- MIME type: \`${mime}\``,
    `- Bytes: ${String(bytes)}`,
  ].join('\n')
}

export function statMarkdown(
  uri: string,
  kind: StatKind,
  path: string,
  size?: number,
  contentType?: string,
): string {
  return [
    `# hf_fs stat`,
    '',
    `- URI: \`${uri}\``,
    `- Exists: ${kind === 'missing' ? 'no' : 'yes'}`,
    `- Type: \`${kind}\``,
    `- Path: \`${path}\``,
    ...(kind === 'file' && size !== undefined ? [`- Size: ${humanSize(size)}`] : []),
    // AFTER the size here, and BEFORE the byte count in `catMarkdown`. The
    // two orders are upstream's, captured separately, and neither is a typo:
    // a repository file carries no Content-Type at all, and only the virtual
    // documentation files declare one.
    ...(contentType === undefined ? [] : [`- Content-Type: \`${contentType}\``]),
  ].join('\n')
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
// What a bounded read has to say about its own bounds. A reader who cannot see
// that the bytes stopped early has no way to ask for the rest, and the captured
// output schema carries `truncated`, `truncation_reason` and `next_offset`
// precisely because the live server tells them.
export interface CatBounds {
  offset: number
  total: number
  next: number
}

export function catMarkdown(
  uri: string,
  path: string,
  content: Uint8Array,
  bounds: CatBounds,
  contentType?: string,
): string {
  const text = Buffer.from(content).toString('utf8')
  const more = bounds.next < bounds.total
  // Captured from the live server, down to the placement. The notice follows
  // the CONTENT rather than joining the header, there is no `Offset:` line
  // even when one was asked for, and the file's total size is never named --
  // a caller learns only that there is more and where to resume. Each of
  // those was ours to get wrong, and each is bytes the model is charged for
  // on every cat, so the wording is upstream's rather than clearer.
  return [
    `# hf_fs cat`,
    '',
    `URI: \`${uri}\``,
    `Path: \`${path}\``,
    ...(contentType === undefined ? [] : [`Content-Type: \`${contentType}\``]),
    `Bytes: ${String(content.length)}`,
    '',
    text,
    ...(more ? ['', `Content truncated. Resume with offset ${String(bounds.next)}.`] : []),
  ].join('\n')
}

// The live server's own error envelope: a bracketed code, a message, then a
// `Recovery:` line. Both codes here were captured; NEITHER is invented, which
// matters because an agent may branch on the code.
export const FS_NOT_FOUND = 'HF_FS_NOT_FOUND'
export const FS_INVALID = 'HF_FS_INVALID_ARGUMENT'
export const FS_TEXT_ONLY = 'HF_FS_TEXT_ONLY'
export const FS_NOT_A_FILE = 'HF_FS_NOT_A_FILE'
// The mirror of NOT_A_FILE, for the commands that need a directory and were
// handed a file. Only reachable on `hf://README.md` today -- inside a
// repository the tree route answers a file path with no rows, which `ls` has
// always reported as an empty listing rather than an error.
export const FS_NOT_A_DIRECTORY = 'HF_FS_NOT_A_DIRECTORY'
// `attach`'s own three. It refuses more precisely than `cat` does, because it
// returns a whole file and cannot truncate: a text file is the wrong KIND of
// thing (use cat), a non-image binary is unsupported media, and an image over
// the limit is simply too large.
export const FS_IMAGE_ONLY = 'HF_FS_IMAGE_ONLY'
export const FS_UNSUPPORTED_MEDIA = 'HF_FS_UNSUPPORTED_MEDIA'
export const FS_IMAGE_TOO_LARGE = 'HF_FS_IMAGE_TOO_LARGE'
export const FS_BUDGET = 'HF_FS_ATTACHMENT_BUDGET_EXCEEDED'

const RECOVERY: Record<string, string> = {
  [FS_NOT_FOUND]:
    'Use stat to verify the target or ls/find to discover a returned URI before retrying.',
  [FS_INVALID]:
    'Correct the URI or flags using the operation grammar and route-specific option guidance.',
  [FS_TEXT_ONLY]:
    'Use stat for metadata or ls on the parent directory. Do not use cat for binary or non-UTF-8 content.',
  [FS_NOT_A_FILE]:
    'Use stat to confirm the target is a file, or ls/find to discover a returned file URI.',
  [FS_NOT_A_DIRECTORY]:
    'Use stat to inspect the target, then run ls or find only on a directory-like scope.',
  [FS_IMAGE_ONLY]: 'Use cat to read this text file, or stat for metadata.',
  [FS_UNSUPPORTED_MEDIA]:
    'Attach supports only files ending in .jpg, .jpeg, .png, or .webp. Use stat for metadata.',
  [FS_IMAGE_TOO_LARGE]:
    'Use stat for metadata. Attach cannot truncate images or exceed its configured complete-file limit.',
  // Upstream's own sentence, curly apostrophe included -- it is bytes the
  // model is charged for, so it is copied rather than tidied.
  [FS_BUDGET]:
    'This attachment was omitted because other attachments already reserved the call\u2019s shared 8 MiB payload budget. Retry it in a separate hf_fs call.',
}

// The live server names a DIFFERENT command in the error object when one
// would help, and names none when nothing would: `stat` answers all three of
// the codes below -- it reports a missing path, a directory and a binary blob
// without erroring on any of them -- while a malformed flag or a bad URI is
// the caller's to fix and gets no suggestion at all. Read off the live
// server for each code rather than assigned by taste.
const SUGGESTED: Record<string, string> = {
  [FS_NOT_FOUND]: 'stat',
  [FS_TEXT_ONLY]: 'stat',
  [FS_NOT_A_FILE]: 'stat',
  [FS_NOT_A_DIRECTORY]: 'stat',
  [FS_UNSUPPORTED_MEDIA]: 'stat',
  [FS_IMAGE_TOO_LARGE]: 'stat',
  // The one that is not `stat`. A text file asked for as an image is not an
  // uncertain target -- it is a known one, reached with the wrong command,
  // and upstream names the right command instead of the diagnostic one.
  [FS_IMAGE_ONLY]: 'cat',
  // `attach` again: the operation was not wrong, only unlucky in its batch,
  // so the thing to do is the same thing in a call of its own.
  [FS_BUDGET]: 'attach',
}

export function fsSuggested(code: string): string | undefined {
  return SUGGESTED[code]
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
