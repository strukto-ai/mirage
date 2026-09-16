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
import { fsStrerror } from '../../utils/errors.ts'
import { gnuBasename } from '../../utils/path.ts'
import { getExtension } from '../resolve.ts'
import { BINARY_EXTENSIONS } from './constants.ts'
import { compilePattern } from './grep_pattern.ts'
import { grepLines } from './grep_scan.ts'
import { grepContextLines } from './grep_context.ts'
import { decodeLine, lineOffsets, matchOffset, prefixOf, printable } from './grep_offsets.ts'
import type { IOResult } from '../../io/types.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { splitLines } from './utils/lines.ts'
import type { AsyncReadBytesFn, AsyncReaddirFn, AsyncStatFn } from './utils/types.ts'

const TYPE_EXTENSIONS: Record<string, string[]> = {
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

function rgMatchesFilter(
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
  noFilename?: boolean
  // -b: prefix each printed line with the byte offset of its own start, or of
  // the match itself under -o.
  byteOffsets?: boolean
}

/**
 * Search one already-read file. `io`, when given, receives exit status 0 as
 * soon as a line is selected: under -o a zero-width match selects the line and
 * prints nothing, so a caller deriving the status from an empty list reports 1
 * where GNU says 0.
 */
function searchFile(
  path: string,
  data: string[],
  compiled: RegExp,
  opts: RgFullOptions,
  prefixPath: string | null,
  io: IOResult | null = null,
): string[] {
  if (opts.maxCount === 0) {
    // ripgrep and GNU both select no line at all under -m0 and print
    // nothing, count included; read before the scan because `count >= 0` is
    // already true at the bottom of the loop.
    return []
  }
  const count = { n: 0 }
  const byteOffsets = opts.byteOffsets === true
  const offsets = byteOffsets ? lineOffsets(data) : []
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
    if (io !== null) io.exitCode = 0
    const start = byteOffsets ? (offsets[i] ?? 0) : 0
    // -l answers with the path, and the path is the whole output, so it is
    // never dropped for want of a label: a single unlabelled operand used to
    // answer with an empty line here where the python twin answered with the
    // file.
    if (opts.filesOnly) return [prefixPath ?? path]
    const lineNo = i + 1
    if (opts.onlyMatching) {
      // GNU -o prints every match on the line, one per line, and prints
      // nothing at all for an empty match nor for an inverted selection,
      // which has no match to print; the line still counts as selected,
      // which is what -c, -l and the exit status read.
      if (!opts.invert && m !== null) {
        globalRe.lastIndex = 0
        for (;;) {
          const hit = globalRe.exec(line)
          if (hit === null) break
          // A global regex that matched the empty string leaves lastIndex
          // where it was, so exec would keep returning it.
          if (hit[0] === '') {
            globalRe.lastIndex += 1
            continue
          }
          const only = printable(
            prefixOf(
              opts.lineNumbers ? lineNo : null,
              byteOffsets ? matchOffset(start, line, hit.index) : null,
            ) + hit[0],
          )
          results.push(prefixPath !== null ? `${prefixPath}:${only}` : only)
        }
        globalRe.lastIndex = 0
      }
    } else {
      const out = printable(
        prefixOf(opts.lineNumbers ? lineNo : null, byteOffsets ? start : null) + line,
      )
      results.push(prefixPath !== null ? `${prefixPath}:${out}` : out)
    }
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
  io: IOResult | null = null,
): Promise<string[]> {
  const compiled = compilePattern(pattern, opts.ignoreCase, opts.fixedString, opts.wholeWord)

  let isDir = false
  let startType: FileType | null = null
  try {
    const s = await statFn(path)
    startType = s.type
    isDir = s.type === FileType.DIRECTORY
  } catch {
    try {
      await readdirFn(path)
      isDir = true
    } catch {
      // not readable
    }
  }

  if (!isDir) {
    if (startType === FileType.CHAR_DEVICE) return []
    if (!rgMatchesFilter(path, opts.fileType, opts.globPattern, opts.hidden)) return []
    let data: string[]
    try {
      data = splitLines(decodeLine(await readBytesFn(path)))
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${path}: ${fsStrerror(err) ?? String(err)}`)
      return []
    }
    if (
      (opts.contextBefore > 0 || opts.contextAfter > 0) &&
      !opts.filesOnly &&
      !opts.countOnly &&
      !opts.onlyMatching &&
      filePrefix === null
    ) {
      // Single-file context rides the shared grep renderer (match lines
      // `N:`, context lines `N-`, `--` between groups). Directory search
      // and filename-prefixed fanout skip context, mirroring grep's -H
      // divergence.
      const rendered = grepContextLines(
        data,
        compiled,
        opts.invert,
        opts.lineNumbers,
        opts.maxCount,
        opts.contextAfter,
        opts.contextBefore,
        opts.byteOffsets === true,
      )
      if (rendered.length > 0 && io !== null) io.exitCode = 0
      // `decodeLine` because the renderer now puts a smuggled byte back as
      // itself; `printable` because this branch answers in `string[]`, which
      // `formatRecords` encodes.
      return rendered.map((chunk) => printable(decodeLine(chunk).replace(/\n$/, '')))
    }
    return searchFile(path, data, compiled, opts, filePrefix, io)
  }

  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(`rg: ${path}: ${fsStrerror(err) ?? String(err)}`)
    return results
  }

  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
      continue
    }

    if (s.type === FileType.DIRECTORY) {
      // box/dropbox readdir marks folders with a trailing slash; strip it so
      // basename sees the real directory name (hidden-dir skip).
      const child = rstripSlash(entry)
      const base = gnuBasename(child)
      if (!opts.hidden && base.startsWith('.')) continue
      const sub = await rgFull(
        readdirFn,
        statFn,
        readBytesFn,
        child,
        pattern,
        opts,
        warnings,
        null,
        io,
      )
      results.push(...sub)
      continue
    }
    if (s.type === FileType.CHAR_DEVICE) continue

    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    if (!rgMatchesFilter(entry, opts.fileType, opts.globPattern, opts.hidden)) continue

    let data: string[]
    try {
      data = splitLines(decodeLine(await readBytesFn(entry)))
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
      continue
    }
    // ripgrep -I drops per-file labels in directory walks; -l keeps
    // paths (they are the output).
    const walkPrefix = opts.noFilename === true && !opts.filesOnly ? null : entry
    const fileResults = searchFile(entry, data, compiled, opts, walkPrefix, io)
    results.push(...fileResults)
  }

  return results
}

export interface RgFolderFiletypeOptions {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  byteOffsets?: boolean
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

/**
 * Walk a folder whose entries render through registered filetype functions.
 *
 * `io`, when given, receives exit status 0 as soon as a line is selected, for
 * the reason `rgFull` takes one: under -o a zero-width match selects the line
 * and prints nothing, so a caller deriving the status from an empty list
 * reports 1 where GNU says 0. This branch has no python counterpart.
 */
export async function rgFolderFiletype(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: RgFolderFiletypeOptions,
  warnings: string[] | null,
  io: IOResult | null = null,
): Promise<string[]> {
  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(`rg: ${path}: ${fsStrerror(err) ?? String(err)}`)
    return results
  }

  const pat = compilePattern(pattern, opts.ignoreCase, opts.fixedString, opts.wholeWord)

  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
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
        io,
      )
      results.push(...sub)
      continue
    }
    if (s.type === FileType.CHAR_DEVICE) continue

    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    if (!rgMatchesFilter(entry, opts.fileType, opts.globPattern, opts.hidden)) continue

    let raw: Uint8Array
    try {
      raw = await readBytesFn(entry)
    } catch (err) {
      if (warnings !== null) warnings.push(`rg: ${entry}: ${fsStrerror(err) ?? String(err)}`)
      continue
    }
    const textLines = splitLines(decodeLine(raw))
    const hits = grepLines(entry, textLines, pat, {
      invert: opts.invert,
      lineNumbers: opts.lineNumbers,
      countOnly: opts.countOnly,
      filesOnly: opts.filesOnly,
      onlyMatching: opts.onlyMatching,
      maxCount: opts.maxCount,
      byteOffsets: opts.byteOffsets === true,
      ...(io !== null ? { io } : {}),
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
