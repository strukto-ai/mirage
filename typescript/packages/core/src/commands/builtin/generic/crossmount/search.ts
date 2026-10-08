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

import { BINARY_EXTENSIONS } from '../../constants.ts'
import { combinedExit } from './fanout/exit.ts'
import { joinRuns } from './fanout/fanout.ts'
import { ownedScopes } from './scopes.ts'
import type { CrossResult, OperandRun, RunSingle, OwnedScope } from './types.ts'
import { mergeOperandIos, runOperands, runSeparator } from './utils.ts'
import { filenameMode, parseFlags } from '../grep.ts'
import {
  labelFlags,
  parseFlags as parseRgFlags,
  rgMatcher,
  walksDescendantMounts,
  walkFilter,
  filtersFiles,
  haystacks,
  sortHaystacks,
} from '../rg.ts'
import type { FlagSet } from '../../grep_binary.ts'
import { patternArg, compilePattern } from '../../grep_pattern.ts'
import { dirAdmitted, fileAdmitted } from '../../grep_select.ts'
import { isStdin, resolveSource } from '../../utils/stream.ts'
import { getExtension } from '../../../resolve.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView, flagOccurrences } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { NamespaceView } from '../../../../view/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../../types.ts'
import { walkErrorLine } from '../../rg_scan.ts'
import { LinkDoor } from '../../utils/links.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { encodeText } from '../../../../shell/bytes.ts'

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
  ns?: NamespaceView,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
): Promise<CrossResult> {
  const view = new FlagView(bag, specOf(name))
  const grep = name === 'grep' ? parseFlags(view) : null
  const rg = name === 'rg' ? parseRgFlags(view) : null
  const nested = paths.some((p) => (ns?.mounts?.descendants(p.virtual).length ?? 0) > 0)
  const linked = paths.some((p) => (ns?.links?.subtree(p.virtual).length ?? 0) > 0)
  const planned =
    rg !== null &&
    (linked ||
      rg.sort !== null ||
      (nested && (rg.maxDepth !== null || rg.follow || rg.oneFileSystem || filtersFiles(rg))))
  if (rg?.typeList) return runSingle(name, paths.slice(0, 1), [...texts], bag)
  if (grep !== null) {
    const pattern = patternArg(texts, bag)
    if (pattern !== null)
      compilePattern(pattern, grep.ignoreCase, grep.fixedString, grep.wholeWord, grep.syntax)
  }
  if (rg !== null && !rg.listFiles) {
    const pattern = patternArg(texts, bag, 'regexp')
    if (pattern !== null) rgMatcher(pattern, false, rg)
  }
  const quiet = grep?.quiet ?? rg?.quiet ?? false
  const input = resolveSource(stdin)
  const execute: RunSingle = (cmd, operands, words, bag) =>
    runSingle(cmd, operands, words, bag, { stdin: operands.some((p) => isStdin(p)) ? input : null })
  const owners = paths.map((p) => ns?.mounts?.rootOf(p.virtual))
  const walk = rg === null ? null : walkFilter(rg)
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
      const door = ns?.links === undefined ? null : new LinkDoor(ns.links, dispatch, cwd)
      const found = haystacks(
        paths,
        readdir,
        stat,
        cwd,
        walk,
        rg,
        warnings,
        rg.oneFileSystem ? (ns?.mounts ?? null) : null,
        door,
      )
      if (rg.sort !== null && rg.sort !== 'none' && !(rg.sort === 'path' && !rg.sortReverse)) {
        const listed = []
        for await (const h of found) listed.push(h)
        for (const message of warnings)
          yield { path: root, walked: false, diagnostic: message + '\n' }
        warnings.length = 0
        for (const h of sortHaystacks(listed, rg))
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
        for (const message of warnings)
          yield { path: root, walked: false, diagnostic: message + '\n' }
        warnings.length = 0
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
      if (rg !== null || grep?.recursive) yield* ownedScopes(path, dispatch, ns, admit)
      else yield { path, walked: false }
    }
  }
  const results: OperandRun[] = []
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
      const owner = ns?.mounts?.rootOf(scope.path.virtual)
      const repeated = owners.filter((o) => o === owner).length > 1
      if (
        scope.stat?.type !== FileType.DIRECTORY ||
        repeated ||
        (scope.walked && !ns?.mounts?.isRoot(scope.path.virtual))
      )
        local.H = true
    }
    const runs = await runOperands(execute, name, [scope.path], [...texts], local)
    results.push(...runs)
    if (quiet && runs.at(-1)?.io.exitCode === 0) break
  }
  const code = combinedExit(
    name,
    results.map((r) => r.io.exitCode),
    results.map((r) => r.io.exitCode !== 0 && r.io.stderr !== null),
    quiet,
  )
  return [
    joinRuns(
      results.map((r) => r.data),
      runSeparator(name, bag),
    ),
    await mergeOperandIos(results, code),
  ]
}

export function walksMounts(name: string, bag: Record<string, FlagValue>): boolean {
  if (name === 'rg') return walksDescendantMounts(bag)
  if (name === 'grep') {
    const view = new FlagView(bag, specOf(name))
    return view.asBool('r') || view.asBool('R')
  }
  return false
}
