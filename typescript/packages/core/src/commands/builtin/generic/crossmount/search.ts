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

import { combinedExit } from './fanout/exit.ts'
import { joinRuns } from './fanout/fanout.ts'
import { ownedScopes } from './scopes.ts'
import type { CrossResult, OperandRun, RunSingle, OwnedScope } from './types.ts'
import { mergeOperandIos, runOperands, runSeparator } from './utils.ts'
import { filenameMode, lineWarnings, parseFlags } from '../grep.ts'
import {
  labelFlags,
  parseFlags as parseRgFlags,
  walkFilter,
  filtersFiles,
  haystacks,
  headed,
  ignoreRules,
  jsonSummary,
  runsParallel,
  sortHaystacks,
} from '../rg.ts'
import type { FlagSet } from '../../grep_binary.ts'
import { patternArg, compilePattern } from '../../grep_pattern.ts'
import type { LineRegex } from '../../../../rs/regex.ts'
import { dirAdmitted, fileAdmitted } from '../../grep_select.ts'
import { isStdin, resolveSource } from '../../utils/stream.ts'
import { BINARY_EXTENSIONS, getExtension } from '../../../../utils/filetype.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView, flagOccurrences } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../../types.ts'
import { WalkBudget } from '../../utils/tree.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { walkErrorLine, type Haystack } from '../../rg_scan.ts'
import { Totals, splitFooter, type RgFlags } from '../../rg_search.ts'
import { formatTotals, openRg } from '../../rg_stream.ts'
import { formatRecords } from '../../utils/output.ts'
import { concat } from '../../../../utils/bytes.ts'
import { LinkResolver, linkView, mountView } from '../../utils/links.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { byteView, encodeText } from '../../../../shell/bytes.ts'
import type { Files } from '../../../../workspace/files.ts'

function admitGrep(flags: FlagSet, path: PathSpec, stat: FileStat): boolean {
  if (stat.type === FileType.DIRECTORY) return dirAdmitted(path.virtual, flags.filters)
  return (
    stat.type === FileType.FILE &&
    fileAdmitted(path.virtual, flags.filters) &&
    (flags.filters.text || !BINARY_EXTENSIONS.has(getExtension(path.virtual) ?? ''))
  )
}

/** Compose registered search handlers in operand order. Global walk modes
 * use its metadata walker, then delegate each selected file. Content
 * always stays with the registered handler. */
export async function runSearch(
  name: string,
  paths: readonly PathSpec[],
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  cwd: string,
  vfs?: Files,
  stdin: ByteSource | null = null,
  utf8 = false,
  signal?: AbortSignal,
): Promise<CrossResult> {
  const started = performance.now()
  const view = new FlagView(bag, specOf(name))
  const grep = name === 'grep' ? parseFlags(view) : null
  const rg = name === 'rg' ? parseRgFlags(view) : null
  // --ignore-file's rules judge every walked file, the ones a nested mount
  // turns into operands of their own runs too; each run reads them again, so
  // a file that could not be read is noted once, here.
  const notes: string[] = []
  const ignores = rg === null ? null : await ignoreRules(view, dispatch, notes)
  const nested = paths.some((p) => (mountView(vfs)?.descendants(p.virtual).length ?? 0) > 0)
  const linked = paths.some((p) => (linkView(vfs)?.subtree(p.virtual).length ?? 0) > 0)
  const planned =
    rg !== null &&
    (linked ||
      rg.sort !== null ||
      (nested &&
        (rg.maxDepth !== null ||
          rg.follow ||
          rg.oneFileSystem ||
          filtersFiles(rg) ||
          ignores?.empty === false)))
  if (rg?.typeList) return runSingle(name, paths.slice(0, 1), [...texts], bag)
  let matcher: LineRegex | null = null
  if (grep !== null) {
    const pattern = patternArg(texts, view)
    if (pattern !== null)
      matcher = compilePattern(
        byteView(pattern, utf8),
        grep.ignoreCase,
        grep.fixedString,
        grep.wholeWord,
        grep.syntax,
        utf8,
        grep.lineRegexp,
      )
  }
  if (rg !== null && !rg.listFiles) {
    const pattern = patternArg(texts, view)
    if (pattern !== null) {
      const program = await openRg(pattern, false, rg)
      program.stream.close()
    }
  }
  const quiet = grep?.quiet ?? rg?.quiet ?? false
  // -q stops at the first match, but --stats and --json count every file.
  const stops = quiet && !(rg !== null && (rg.stats === true || rg.json === true))
  const input = resolveSource(stdin)
  const execute: RunSingle = (cmd, operands, words, bag) =>
    runSingle(cmd, operands, words, bag, { stdin: operands.some((p) => isStdin(p)) ? input : null })
  const owners = paths.map((p) => mountView(vfs)?.rootOf(p.virtual))
  const walk = rg === null ? null : walkFilter(rg, undefined, ignores ?? undefined)
  const admit = (path: PathSpec, stat: FileStat): boolean => {
    if (grep !== null) return admitGrep(grep, path, stat)
    if (walk === null) throw new Error(`No traversal filter for ${name}`)
    const base = path.virtual.split('/').at(-1) ?? ''
    if (stat.type === FileType.DIRECTORY) return walk.admits(path.virtual, base, true)
    return stat.type === FileType.FILE && walk.admitsFile(path.virtual, base, stat)
  }
  const readdir = async (virtual: string): Promise<string[]> => {
    const [data] = await dispatch('readdir', PathSpec.fromStrPath(virtual))
    return data as string[]
  }
  const stat = async (virtual: string): Promise<FileStat> => {
    const [data] = await dispatch('stat', PathSpec.fromStrPath(virtual), [], { nofollow: true })
    return data as FileStat
  }
  const root = paths[0] ?? PathSpec.fromStrPath(cwd)
  async function* scopes(): AsyncIterable<OwnedScope> {
    if (planned && walk !== null) {
      const warnings: string[] = []
      const stopped = new Set<string>()
      const mounts = mountView(vfs) ?? null
      const budgets = new Map(paths.map((p) => [p.virtual, new WalkBudget(p, mounts)]))
      const reported = new Set<string>()
      const listing = rg.listFiles
      // The plan hands each file over alone, which no search narrows, so
      // each file counts here against the mount serving it; a listing reads
      // none.
      const charged = (h: Haystack): boolean => {
        if (h.spec !== null || listing) return true
        const top = paths.find((p) => h.virtual.startsWith(`${rstripSlash(p.virtual)}/`))
        const budget = top === undefined ? undefined : budgets.get(top.virtual)
        if (top === undefined || budget === undefined || budget.spend(h.virtual)) return true
        if (!budget.opens(top.virtual)) stopped.add(top.virtual)
        for (const line of budget.stopped) {
          if (reported.has(line)) continue
          reported.add(line)
          warnings.push(`rg: ${line}`)
        }
        return false
      }
      const links = linkView(vfs)
      const resolver = links === undefined ? null : new LinkResolver(links, dispatch, cwd)
      const found = haystacks(
        paths,
        readdir,
        stat,
        cwd,
        walk,
        rg,
        warnings,
        rg.oneFileSystem ? (mounts ?? null) : null,
        resolver,
        stopped,
      )
      if (rg.sort !== null && rg.sort !== 'none' && !(rg.sort === 'path' && !rg.sortReverse)) {
        const listed = []
        for await (const h of found) listed.push(h)
        const kept = sortHaystacks(listed, rg).filter(charged)
        for (const message of warnings)
          yield { path: root, walked: false, diagnostic: message + '\n' }
        warnings.length = 0
        for (const h of kept)
          yield {
            path:
              h.spec ??
              new PathSpec({
                virtual: h.virtual,
                directory: PathSpec.fromStrPath(h.virtual).directory,
                vfsPath: PathSpec.fromStrPath(h.virtual).vfsPath,
                rawPath: h.shown,
              }),
            walked: h.spec === null,
            ...(h.stat === null ? {} : { stat: h.stat }),
          }
        return
      }
      for await (const h of found) {
        const admitted = charged(h)
        for (const message of warnings)
          yield { path: root, walked: false, diagnostic: message + '\n' }
        warnings.length = 0
        if (!admitted) continue
        yield {
          path:
            h.spec ??
            new PathSpec({
              virtual: h.virtual,
              directory: PathSpec.fromStrPath(h.virtual).directory,
              vfsPath: PathSpec.fromStrPath(h.virtual).vfsPath,
              rawPath: h.shown,
            }),
          walked: h.spec === null,
          ...(h.stat === null ? {} : { stat: h.stat }),
        }
      }
      for (const message of warnings)
        yield { path: root, walked: false, diagnostic: message + '\n' }
      return
    }
    for (const path of paths) {
      if (rg !== null || grep?.recursive) yield* ownedScopes(path, dispatch, vfs, admit)
      else yield { path, walked: false }
    }
  }
  const results: OperandRun[] = []
  const walked = new Set<number>()
  for await (const scope of scopes()) {
    signal?.throwIfAborted()
    if (scope.error !== undefined || scope.diagnostic !== undefined) {
      const message =
        scope.diagnostic ??
        (scope.error === undefined
          ? ''
          : rg === null
            ? fsErrorLine(name, scope.path, scope.error)
            : walkErrorLine(
                scope.path.rawPath,
                scope.error,
                rg.threads !== 1 && (paths.length > 1 || scope.walked),
              ) + '\n')
      results.push({
        scope: scope.path,
        data: new Uint8Array(),
        io: new IOResult({
          exitCode: 2,
          stderr: rg?.noMessages ? null : encodeText(message),
        }),
      })
      continue
    }
    const local = grep === null ? labelFlags(bag) : { ...bag }
    if (grep !== null) flagOccurrences(local).push(...flagOccurrences(bag))
    if (grep !== null && filenameMode(view) === null) {
      const owner = mountView(vfs)?.rootOf(scope.path.virtual)
      const repeated = owners.filter((o) => o === owner).length > 1
      if (
        scope.stat?.type !== FileType.DIRECTORY ||
        repeated ||
        (scope.walked && !mountView(vfs)?.isRoot(scope.path.virtual))
      )
        local.with_filename = true
    }
    const runs = await runOperands(execute, name, [scope.path], [...texts], local)
    if (scope.stat?.type === FileType.DIRECTORY) walked.add(results.length)
    results.push(...runs)
    if (stops && runs.at(-1)?.io.exitCode === 0) break
  }
  const code = combinedExit(
    name,
    results.map((r) => r.io.exitCode),
    results.map((r) => r.io.exitCode !== 0 && r.io.stderr !== null),
    quiet,
  )
  const [parts, footer] =
    rg !== null && (rg.stats === true || rg.json === true)
      ? await oneFooter(results, rg, walked, started)
      : [results.map((r) => r.data), new Uint8Array()]
  const body = concat([joinRuns(parts, runSeparator(name, bag)), footer])
  // Each run says what the line says once, grep's warnings or rg's notes of
  // the ignore files it could not read; the line keeps one.
  const noted =
    grep !== null
      ? encodeText(lineWarnings(view, matcher))
      : rg !== null && notes.length > 0 && !rg.noMessages
        ? formatRecords(notes)
        : new Uint8Array()
  if (noted.length === 0) return [body, await mergeOperandIos(results, code)]
  for (const r of results) {
    if (r.io.stderr === null) continue
    const err = await materialize(r.io.stderr)
    const kept =
      err.length >= noted.length && noted.every((byte, i) => err[i] === byte)
        ? err.subarray(noted.length)
        : err
    r.io.stderr = kept.length === 0 ? null : kept
  }
  const io = await mergeOperandIos(results, code)
  io.stderr = concat([noted, io.stderr === null ? new Uint8Array() : await materialize(io.stderr)])
  return [body, io]
}

/**
 * The runs' outputs with each --stats block or --json summary cut off, and
 * the one footer that totals them, as a single rg prints it. A run that walked
 * a directory on ripgrep's parallel searcher closed its last --heading group
 * with a blank line too; that line goes with its footer. Mirrors Python's
 * `_one_footer`.
 */
async function oneFooter(
  results: readonly OperandRun[],
  f: RgFlags,
  walked: ReadonlySet<number>,
  started: number,
): Promise<[Uint8Array[], Uint8Array]> {
  const summary = jsonSummary(f)
  const blank = !summary && headed(f) && runsParallel(f)
  const parts = results.map((r) => r.data)
  const totals = new Totals()
  let found = false
  for (const [i, data] of parts.entries()) {
    const [head, part] = splitFooter(data, summary)
    if (part === null) continue
    found = true
    totals.merge(part)
    parts[i] = blank && head.length > 0 && walked.has(i) ? head.subarray(0, -1) : head
  }
  if (!found) return [parts, new Uint8Array()]
  const total = (performance.now() - started) / 1000
  if (summary) return [parts, await formatTotals(totals, 'summary', total)]
  const printed = parts.some((d) => d.length > 0)
  return [
    parts,
    concat([
      blank && printed ? encodeText('\n') : new Uint8Array(),
      await formatTotals(totals, 'stats', total),
    ]),
  ]
}
