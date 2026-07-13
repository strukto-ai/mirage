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

import type { FileStat } from '../../types.ts'
import { FileType } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { gnuBasename } from '../../utils/path.ts'
import { getExtension } from '../resolve.ts'
import { BINARY_EXTENSIONS, compilePattern, grepLines } from './grep_helper.ts'
import { fnmatch } from '../../utils/fnmatch.ts'

export const TYPE_EXTENSIONS: Record<string, string[]> = {
  py: ['.py'],
  js: ['.js', '.jsx'],
  ts: ['.ts', '.tsx'],
  java: ['.java'],
  go: ['.go'],
  rs: ['.rs'],
  rb: ['.rb'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.hpp', '.cc', '.cxx'],
  css: ['.css'],
  html: ['.html', '.htm'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  md: ['.md'],
  txt: ['.txt'],
  xml: ['.xml'],
  sql: ['.sql'],
  sh: ['.sh', '.bash'],
  csv: ['.csv'],
}

export type AsyncReaddirFn = (path: string) => Promise<string[]>
export type AsyncStatFn = (path: string) => Promise<FileStat>
export type AsyncReadBytesFn = (path: string) => Promise<Uint8Array>

export function rgMatchesFilter(
  entry: string,
  fileType: string | null,
  globPattern: string | null,
  hidden: boolean,
): boolean {
  const base = gnuBasename(entry)
  if (!hidden && base.startsWith('.')) return false
  if (fileType !== null) {
    const exts = TYPE_EXTENSIONS[fileType] ?? [`.${fileType}`]
    if (!exts.some((ext) => entry.endsWith(ext))) return false
  }
  if (globPattern !== null && !fnmatch(base, globPattern)) return false
  return true
}

export interface RgFullOptions {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  wholeWord: boolean
  contextBefore: number
  contextAfter: number
  fileType: string | null
  globPattern: string | null
  hidden: boolean
}

function searchFile(
  data: string[],
  compiled: RegExp,
  opts: RgFullOptions,
  prefixPath: string | null,
): string[] {
  const count = { n: 0 }
  const globalRe = opts.onlyMatching
    ? new RegExp(
        compiled.source,
        compiled.flags.includes('g') ? compiled.flags : compiled.flags + 'g',
      )
    : compiled
  const results: string[] = []
  for (let i = 0; i < data.length; i++) {
    const line = data[i] ?? ''
    const m = globalRe.exec(line)
    globalRe.lastIndex = 0
    const matched = Boolean(m) !== opts.invert
    if (!matched) continue
    count.n += 1
    if (opts.filesOnly) {
      if (prefixPath !== null) return [prefixPath]
      return ['']
    }
    const lineNo = i + 1
    let text: string
    if (opts.onlyMatching && m !== null && !opts.invert) {
      text = m[0]
    } else {
      text = line
    }
    const out = opts.lineNumbers ? `${String(lineNo)}:${text}` : text
    results.push(prefixPath !== null ? `${prefixPath}:${out}` : out)
    if (opts.maxCount !== null && count.n >= opts.maxCount) break
  }
  if (opts.countOnly) {
    if (count.n === 0) return []
    return prefixPath !== null ? [`${prefixPath}:${String(count.n)}`] : [String(count.n)]
  }
  return results
}

export async function rgFull(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: RgFullOptions,
  warnings: string[] | null,
  filePrefix: string | null = null,
): Promise<string[]> {
  const compiled = compilePattern(pattern, opts.ignoreCase, opts.fixedString, opts.wholeWord)

  let isDir = false
  try {
    const s = await statFn(path)
    isDir = s.type === FileType.DIRECTORY
  } catch {
    try {
      await readdirFn(path)
      isDir = true
    } catch {
      // not readable
    }
  }

  const DEC = new TextDecoder('utf-8', { fatal: false })

  if (!isDir) {
    if (!rgMatchesFilter(path, opts.fileType, opts.globPattern, opts.hidden)) return []
    let data: string[]
    try {
      const raw = await readBytesFn(path)
      data = DEC.decode(raw).split('\n')
      if (data.length > 0 && data[data.length - 1] === '') data.pop()
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${path}: ${String(err)}`)
      return []
    }
    return searchFile(data, compiled, opts, filePrefix)
  }

  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(`rg: ${path}: ${String(err)}`)
    return results
  }

  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${String(err)}`)
      continue
    }

    if (s.type === FileType.DIRECTORY) {
      // box/dropbox readdir marks folders with a trailing slash; strip it so
      // basename sees the real directory name (hidden-dir skip).
      const child = rstripSlash(entry)
      const base = gnuBasename(child)
      if (!opts.hidden && base.startsWith('.')) continue
      const sub = await rgFull(readdirFn, statFn, readBytesFn, child, pattern, opts, warnings)
      results.push(...sub)
      continue
    }

    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    if (!rgMatchesFilter(entry, opts.fileType, opts.globPattern, opts.hidden)) continue

    let data: string[]
    try {
      const raw = await readBytesFn(entry)
      data = DEC.decode(raw).split('\n')
      if (data.length > 0 && data[data.length - 1] === '') data.pop()
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${String(err)}`)
      continue
    }
    const fileResults = searchFile(data, compiled, opts, entry)
    results.push(...fileResults)
  }

  return results
}

export interface RgFolderFiletypeOptions {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  onlyMatching: boolean
  maxCount: number | null
  fixedString: boolean
  wholeWord: boolean
  fileType: string | null
  globPattern: string | null
  hidden: boolean
}

export async function rgFolderFiletype(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: RgFolderFiletypeOptions,
  warnings: string[] | null,
): Promise<string[]> {
  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(`rg: ${path}: ${String(err)}`)
    return results
  }

  const pat = compilePattern(pattern, opts.ignoreCase, opts.fixedString, opts.wholeWord)
  const DEC = new TextDecoder('utf-8', { fatal: false })

  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${String(err)}`)
      continue
    }

    if (s.type === FileType.DIRECTORY) {
      const sub = await rgFolderFiletype(
        readdirFn,
        statFn,
        readBytesFn,
        entry,
        pattern,
        opts,
        warnings,
      )
      results.push(...sub)
      continue
    }

    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    if (!rgMatchesFilter(entry, opts.fileType, opts.globPattern, opts.hidden)) continue

    let raw: Uint8Array
    try {
      raw = await readBytesFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${String(err)}`)
      continue
    }
    const textLines = DEC.decode(raw).split('\n')
    if (textLines.length > 0 && textLines[textLines.length - 1] === '') textLines.pop()
    const hits = grepLines(entry, textLines, pat, {
      invert: opts.invert,
      lineNumbers: opts.lineNumbers,
      countOnly: opts.countOnly,
      filesOnly: opts.filesOnly,
      onlyMatching: opts.onlyMatching,
      maxCount: opts.maxCount,
    })
    if (opts.countOnly) {
      const c = hits[0] ?? '0'
      if (c !== '0') results.push(`${entry}:${c}`)
    } else if (opts.filesOnly) {
      for (const h of hits) results.push(h)
    } else {
      for (const h of hits) results.push(`${entry}:${h}`)
    }
  }

  return results
}
