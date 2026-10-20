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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

// The namespace's own link table answers for every session at once: a link a
// session cannot see is still in it, with its row and its target. Above the
// dispatcher a link is read through the session's table
// (`Namespace.sessionLinks`), which answers as the session sees it, so a link
// it cannot see is no link to any command. Reading the whole table there is
// how `readlink -f` came to go quiet on a hidden link, a hard link came to
// copy one, and `touch -h` came to touch one, each while the same name truly
// absent answered otherwise.
//
// The dispatcher is the one reader of the whole table: it decides what a
// session sees, and refuses a write over a name it cannot see. This is the
// mirror of `tests/workspace/test_session_link_reads.py`.
const WHOLE_TABLE = 'workspace/dispatcher/dispatcher.ts'

const MEMBERS = [
  'follow',
  'followParent',
  'isLink',
  'readlink',
  'linkStatAt',
  'symlinkTargets',
  'linkStatsBelow',
  'linkNamesUnder',
]

// A member read off a receiver named `namespace` (`namespace.follow`,
// `this.namespace.follow`, `deps.namespace.isLink`).
const READ = new RegExp(
  String.raw`(?<![\w$])_?namespace\s*[?!]?\.\s*(?:${MEMBERS.join('|')})(?![\w$])`,
  'g',
)
// The namespace handed over as a link table by name (`links: namespace`).
const HANDED = /(?<![\w$])links\s*:\s*(?:[\w$]+\.)*_?namespace(?![\w$]|\s*[?!]?\.|\s*\()/g
// The namespace handed over as a link table by position: the argument a
// function names `links` (`resolveGlobs(words, registry, false, namespace)`).
const NAMESPACE_ARG = /^(?:[\w$]+\.)*_?namespace(?:\s*\?\?\s*null)?$/
const DECLARED = /(?<![\w$])function\s*\*?\s*([\w$]+)\s*(?:<[^()]*>)?\s*\(/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out.sort()
}

/**
 * The source with its comments blanked out, newlines kept, so a word in a
 * comment is no read and an apostrophe there opens no string.
 */
function code(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1
      out += text.slice(i, end + 1)
      i = end
      continue
    }
    const close = text.startsWith('//', i) ? '\n' : text.startsWith('/*', i) ? '*/' : null
    if (close === null) {
      out += ch
      continue
    }
    const end = text.indexOf(close, i + 2)
    const stop = end < 0 ? text.length : close === '\n' ? end : end + 2
    out += text.slice(i, stop).replace(/[^\n]/g, ' ')
    i = stop - 1
  }
  return out
}

/**
 * The top-level comma-separated pieces of the parenthesized list opening at
 * `open`, or null when it does not close. `angles` nests `<>` too, which a
 * parameter list's types need and an argument list's comparisons must not.
 */
function listAt(text: string, open: number, angles: boolean): string[] | null {
  const pieces: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      let close = i + 1
      while (close < text.length && text[close] !== ch) close += text[close] === '\\' ? 2 : 1
      if (close >= text.length) return null
      i = close
      continue
    }
    const opens = ch === '(' || ch === '[' || ch === '{' || (angles && ch === '<')
    const closes =
      ch === ')' || ch === ']' || ch === '}' || (angles && ch === '>' && text[i - 1] !== '=')
    if (opens) depth += 1
    else if (closes) {
      depth -= 1
      if (depth === 0) {
        pieces.push(text.slice(start, i))
        return pieces.map((p) => p.trim()).filter((p) => p !== '')
      }
    } else if (ch === ',' && depth === 1) {
      pieces.push(text.slice(start, i))
      start = i + 1
    }
  }
  return null
}

/** Where each function declares a parameter named `links`, by name. */
function linkParameters(texts: readonly string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (const text of texts) {
    for (const match of text.matchAll(DECLARED)) {
      const name = match[1]
      const params = listAt(text, match.index + match[0].length - 1, true)
      if (name === undefined || params === null) continue
      const at = params.findIndex((p) => /^(?:\.\.\.)?links\b/.test(p))
      if (at >= 0) found.set(name, at)
    }
  }
  return found
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * Every read of the namespace's link table, and every hand-off of the
 * namespace as a link table, as `path:line`.
 */
function wholeTableReads(): string[] {
  const files = sourceFiles(SRC).map((file) => ({
    rel: relative(SRC, file).split('\\').join('/'),
    text: code(readFileSync(file, 'utf8')),
  }))
  const takers = linkParameters(files.map((f) => f.text))
  const calls = new RegExp(String.raw`(?<![\w$.])(${[...takers.keys()].join('|')})\s*\(`, 'g')
  const found: string[] = []
  for (const { rel, text } of files) {
    if (rel === WHOLE_TABLE) continue
    for (const pattern of [READ, HANDED]) {
      for (const match of text.matchAll(pattern))
        found.push(`${rel}:${String(lineOf(text, match.index))}`)
    }
    for (const match of text.matchAll(calls)) {
      if (/function\s*\*?\s*$/.test(text.slice(0, match.index))) continue
      const at = takers.get(match[1] ?? '')
      const args = listAt(text, match.index + match[0].length - 1, false)
      if (at === undefined || args === null) continue
      if (NAMESPACE_ARG.test(args[at] ?? ''))
        found.push(`${rel}:${String(lineOf(text, match.index))}`)
    }
  }
  return found
}

describe('session link reads', () => {
  it('links above the dispatcher are the session’s', () => {
    expect(
      wholeTableReads(),
      "the namespace's whole link table read above the dispatcher. Read the " +
        "session's instead (`namespace.sessionLinks(session)`), which answers " +
        'as the session sees each link.',
    ).toEqual([])
  })
})
