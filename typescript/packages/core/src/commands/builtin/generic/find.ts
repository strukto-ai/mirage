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

import { modifiedTs } from '../../../core/generic/find.ts'
import {
  bindTree,
  emitStartPath,
  argsToTree,
  primeRegexes,
  printfKind,
  quitFired,
  startBasename,
  timeTestsFailing,
  treeHasTime,
  unrespellRaw,
} from '../../../core/generic/find_eval.ts'
import { type FindArgs, type PredNode } from '../../../core/generic/types.ts'
import {
  fsStrerror,
  isEnoent,
  isEnotdir,
  isMissError,
  strerrorOf,
  walkRefusal,
} from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { IOResult, type PathRecord } from '../../../io/types.ts'
import { parseFindExpression, type FindExpr } from '../../../rs/find.ts'
import { FileType, Follow, LineFacts, PathSpec, type FileStat } from '../../../types.ts'
import { respellOne, respellRaw } from '../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { readerOf } from '../../../workspace/files.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { linksOf } from '../utils/links.ts'
import { dotRefusal, linkFollow, statOrEnoent, vfsStatPath } from '../utils/paths.ts'

const ENC = new TextEncoder()

// The structured row the action layer acts on: the resolved path, spelled
// as it prints.
function matchedPath(row: string, root: PathSpec): PathSpec {
  const virtual = unrespellRaw(row, root.virtual, root.rawPath || root.virtual)
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: stripSlash(virtual),
    rawPath: row,
    resolved: true,
  })
}

// Results for a start point that is not a directory.
//
// GNU reports a non-directory start point when it matches the expression
// and walks nothing, because there is no subtree to descend. The entry
// sits at depth 0 and tests as `f`, offering its own size and mtime to
// -size, -mtime and -empty.
//
// Asking a backend to walk one instead is what this replaces, and every
// backend answered differently: an object store listed the key as a
// prefix and returned nothing, Graph 404'd on the children of a file, and
// Box raised ENOTDIR.
function startPointResults(
  root: PathSpec,
  start: FileStat,
  options: FindArgs,
  tree: PredNode,
  usesEmpty: boolean,
  mtimeMin: number | null,
  mtimeMax: number | null,
): string[] {
  const results: string[] = []
  let ts: number | null = null
  if (mtimeMin !== null || mtimeMax !== null) {
    ts = modifiedTs(start.modified ?? null)
    if (ts === null || Number.isNaN(ts)) return results
    if (mtimeMin !== null && ts < mtimeMin) return results
    if (mtimeMax !== null && ts > mtimeMax) return results
  } else if (treeHasTime(tree)) {
    ts = modifiedTs(start.modified ?? null)
  }
  const judged = ts === null && treeHasTime(tree) ? timeTestsFailing(tree) : tree
  emitStartPath(results, rstripSlash(root.virtual) || '/', startBasename(root.virtual), {
    kind: printfKind(start),
    isEmpty: usesEmpty && printfKind(start) === 'f' ? start.size === 0 : usesEmpty ? false : null,
    exists: true,
    tree: judged,
    maxDepth: options.maxDepth ?? null,
    minDepth: options.minDepth ?? null,
    size: start.size ?? null,
    minSize: options.minSize ?? null,
    maxSize: options.maxSize ?? null,
    mtime: ts,
    stat: start,
  })
  return results
}

// The strerror of a start point statPath found nothing at. statPath answers
// null for both ways a lookup fails, because every other caller of it treats
// them alike, while GNU names the one its stat met. So the mount's own stat
// is asked which, on the failure path only: a start point under a plain file
// is ENOTDIR. Mirrors _missing_start_detail in find.py.
async function missingStartDetail(
  root: PathSpec,
  stat: ((spec: PathSpec) => Promise<FileStat>) | undefined,
): Promise<string> {
  if (stat === undefined) return posixPhrase('ENOENT')
  try {
    await stat(root)
  } catch (err) {
    if (isEnotdir(err)) return posixPhrase('ENOTDIR')
    if (isMissError(err)) return posixPhrase('ENOENT')
    throw err
  }
  return posixPhrase('ENOENT')
}

interface FindFlags {
  readonly name: string | null
  readonly type: string | null
  readonly size: string | null
  readonly mtime: string | null
  readonly maxdepth: string | null
  readonly iname: string | null
  readonly path: string | null
  readonly mindepth: string | null
  readonly empty: boolean
}

function parseFlags(bag: Record<string, FlagValue>): FindFlags {
  const fl = new FlagView(bag, specOf('find'))
  return {
    name: fl.asStr('name') ?? null,
    type: fl.asStr('type') ?? null,
    size: fl.asStr('size') ?? null,
    mtime: fl.asStr('mtime') ?? null,
    maxdepth: fl.asStr('maxdepth') ?? null,
    iname: fl.asStr('iname') ?? null,
    path: fl.asStr('path') ?? null,
    mindepth: fl.asStr('mindepth') ?? null,
    empty: fl.asBool('empty'),
  }
}

export function findGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  // The walk of one start point, given its stat when this already has it.
  find: (root: PathSpec, options: FindArgs, start: FileStat | null) => AsyncIterable<string>,
  unreadable?: () => string[],
  unstatted?: () => [string, unknown][],
  // A walker already evaluates times in its predicate tree. Its raw stat is
  // needed only to distinguish ENOTDIR from ENOENT at a missing start point.
  missingStat?: (spec: PathSpec) => Promise<FileStat>,
  // Under -L, each directory the walk reached again and the one above it
  // that it repeats.
  loops?: () => [string, string][],
  // Where a walk ran past walkLimit, each line without the command's
  // name.
  stopped?: () => string[],
  // Whether the walk reached a -quit, which ends the line.
  quitted?: () => boolean,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  const nameFlag = parsed.name
  const inameFlag = parsed.iname
  const typeFlag = parsed.type
  const pathFlag = parsed.path
  const maxDepthFlag = parsed.maxdepth
  const minDepthFlag = parsed.mindepth
  const sizeFlag = parsed.size
  const mtimeFlag = parsed.mtime
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            vfsPath: '',
            virtual: '/',
            directory: '/',
            resolved: false,
          }),
        ]
  // Passed through rather than narrowed to f/d: `-type l` is a real value
  // (namespace symlinks), and collapsing anything else to "no filter" would
  // make the flag form print every entry where python prints none.
  const findType: string | null = typeFlag
  const expr: FindExpr | null = ctx.find ?? (texts.length > 0 ? parseFindExpression(texts) : null)
  const flagWords = [
    ...(maxDepthFlag !== null ? ['-maxdepth', maxDepthFlag] : []),
    ...(minDepthFlag !== null ? ['-mindepth', minDepthFlag] : []),
    ...(sizeFlag !== null ? ['-size', sizeFlag] : []),
    ...(mtimeFlag !== null ? ['-mtime', mtimeFlag] : []),
  ]
  let limits: FindExpr | null = null
  try {
    limits = expr === null && flagWords.length > 0 ? parseFindExpression(flagWords) : null
  } catch (err) {
    if (err instanceof UsageError) {
      return Promise.resolve([
        null,
        new IOResult({ exitCode: 1, stderr: ENC.encode(`${err.message}\n`) }),
      ])
    }
    throw err
  }
  const maxDepth = limits?.maxDepth ?? null
  const minDepth = limits?.minDepth ?? null
  const minSize = limits?.minSize ?? null
  const maxSize = limits?.maxSize ?? null
  const mtimeMin = limits?.mtimeMin ?? null
  const mtimeMax = limits?.mtimeMax ?? null
  const emptyFlag = parsed.empty
  const effMtimeMin = expr !== null ? expr.mtimeMin : mtimeMin
  const effMtimeMax = expr !== null ? expr.mtimeMax : mtimeMax
  const options: FindArgs =
    expr !== null
      ? {
          tree: expr.tree,
          ...(expr.maxDepth !== null ? { maxDepth: expr.maxDepth } : {}),
          ...(expr.minDepth !== null ? { minDepth: expr.minDepth } : {}),
          ...(expr.minSize !== null ? { minSize: expr.minSize } : {}),
          ...(expr.maxSize !== null ? { maxSize: expr.maxSize } : {}),
          ...(expr.mtimeMin !== null ? { mtimeMin: expr.mtimeMin } : {}),
          ...(expr.mtimeMax !== null ? { mtimeMax: expr.mtimeMax } : {}),
          ...(expr.usesEmpty ? { empty: true } : {}),
          ...(expr.depthFirst ? { depthFirst: true } : {}),
        }
      : {
          name: nameFlag,
          iname: inameFlag,
          type: findType,
          ...(maxDepth !== null ? { maxDepth } : {}),
          ...(minDepth !== null ? { minDepth } : {}),
          ...(minSize !== null ? { minSize } : {}),
          ...(maxSize !== null ? { maxSize } : {}),
          ...(mtimeMin !== null ? { mtimeMin } : {}),
          ...(mtimeMax !== null ? { mtimeMax } : {}),
          ...(pathFlag !== null ? { pathPattern: pathFlag } : {}),
          ...(emptyFlag ? { empty: true } : {}),
        }
  const records: PathRecord[] = []
  const io = new IOResult({ records })
  async function* stream(): AsyncGenerator<Uint8Array> {
    const missing: string[] = []
    // Each row names the start point it was found under, in operand order:
    // the action layer acts on each traversal on its own and reads a row's
    // start point off it (-printf's %P and %d).
    for (const [run, root] of targets.entries()) {
      // `-path` matches the row as printed; stamp the operand's spelling onto
      // path nodes before the walk (#396). Bound per start point: options is
      // shared by every one of them and must stay unbound.
      const tree = bindTree(argsToTree(options), '', root.virtual, root.rawPath)
      const rootOptions: FindArgs = { ...options, tree }
      const rootKey = rstripSlash(root.virtual) || '/'
      await primeRegexes(tree, [rootKey])
      // A start point that is itself a symlink is the walk's to report: the
      // table it walks answers the link's own row, and GNU's default -P
      // reports the link and stops there. The dispatcher's stat would follow
      // it, so the start point's checks below leave it alone.
      const rootIsLink = (linksOf(ctx) ?? null)?.statAt(root.virtual) != null
      let known: FileStat | null = null
      // What the start point is decides which walk is even possible, so it
      // is resolved once, ahead of all of them: a symlink is walked as
      // itself, a non-directory has no subtree, and nothing at all is GNU's
      // diagnostic. Statted through the dispatcher,
      // so a start point the router already resolved into another mount
      // answers there rather than on this command's mount.
      // The probe asks both channels a backend can answer on, so a directory
      // that exists only as its children still reports as one and null means
      // nothing is there (see resolvePathStat). That is what makes the
      // missing case answerable above every backend rather than only where
      // one wires a stat.
      const startStat = vfsStatPath(ctx.vfs)
      if (root.walkError !== null) {
        // The walk refused the start point before find ran (the empty
        // name, a link loop), and every probe below goes by the path it
        // simplifies to. Mirrors Python's resolve_start.
        missing.push(
          `find: '${root.rawPath}': ${fsStrerror(walkRefusal(root)) ?? posixPhrase('ENOENT')}`,
        )
        continue
      }
      // A start point's own `.` and `..` resolve first, link or not: the
      // lookup below asks about the path they simplify to.
      if (startStat !== undefined) {
        const refusal = await dotRefusal(statOrEnoent(startStat), root, linkFollow(linksOf(ctx)))
        if (refusal !== null) {
          const label = root.rawPath !== '' ? root.rawPath : root.virtual
          missing.push(`find: '${label}': ${fsStrerror(refusal) ?? posixPhrase('ENOENT')}`)
          continue
        }
      }
      if (startStat !== undefined && !rootIsLink) {
        let start: FileStat | null
        try {
          start = await startStat(root.virtual)
        } catch (err) {
          // A start point the dispatcher refuses to stat is GNU's own
          // diagnostic for it, quoted like a missing one
          // (`find: 'P': Permission denied`), not an escaped error.
          const detail = fsStrerror(err)
          if (detail === null) throw err
          missing.push(`find: '${root.rawPath !== '' ? root.rawPath : root.virtual}': ${detail}`)
          continue
        }
        if (start === null) {
          // GNU names each start point it cannot stat, keeps going with the
          // rest, and exits 1. Reported as the operand was typed, falling
          // back to the resolved path for a synthesized root.
          const label = root.rawPath !== '' ? root.rawPath : root.virtual
          missing.push(`find: '${label}': ${await missingStartDetail(root, missingStat)}`)
          continue
        }
        if (start.type !== FileType.DIRECTORY && root.rawPath.endsWith('/')) {
          // POSIX reads `x/` as `x/.`, so an operand typed with a trailing
          // slash has to name a directory; GNU refuses the rest with
          // ENOTDIR rather than reporting the entry itself.
          missing.push(`find: '${root.rawPath}': Not a directory`)
          continue
        }
        known = start
        if (start.type !== FileType.DIRECTORY) {
          const rows = startPointResults(
            root,
            start,
            rootOptions,
            argsToTree(rootOptions),
            expr !== null ? expr.usesEmpty : emptyFlag,
            effMtimeMin,
            effMtimeMax,
          )
          // The only row possible is the start point itself, so its display
          // path is the operand, not a key that needs rebasing.
          if (rows.length > 0) {
            const display = root.virtual === '/' ? '/' : rstripSlash(root.virtual)
            const added = respellRaw([display], root.virtual, root.rawPath)
            yield ENC.encode(added.join('\n') + '\n')
            for (const r of added) records.push({ path: matchedPath(r, root), run })
          }
          // A -quit reached on the start point itself ends the line.
          if (quitFired(tree)) break
          continue
        }
      }
      // Hidden rows drop here, above the walk, so a mount's visibility
      // behavior is decided once for every backend.
      const reader = ctx.vfs === undefined ? null : readerOf(ctx.vfs)
      try {
        for await (const key of find(root, rootOptions, known)) {
          const display =
            root.virtual === '/'
              ? key
              : rootKey === '/' && key === '/'
                ? rstripSlash(root.virtual)
                : rstripSlash(root.virtual) + key.slice(rootKey === '/' ? 0 : rootKey.length)
          if (reader !== null && !reader.visible(display)) continue
          const row = respellOne(display, root.virtual, root.rawPath)
          yield ENC.encode(row + '\n')
          records.push({ path: matchedPath(row, root), run })
        }
      } catch (err) {
        // GNU find reports missing roots and moves on; anything else
        // (rate limits, auth failures) must surface.
        if (isEnoent(err)) continue
        throw err
      }
      // GNU names a directory it may not open in the walk's own order,
      // lists the directory itself, and exits 1 like a start point it
      // could not read. Drained per start point, so the lines stay under
      // the operand that walked them.
      for (const shown of respellRaw(unreadable?.() ?? [], root.virtual, root.rawPath)) {
        missing.push(`find: '${shown}': Permission denied`)
      }
      // An entry the walk could not stat is named the same way, and stays
      // listed where no test needed its stat.
      for (const [path, err] of unstatted?.() ?? []) {
        const shown = respellOne(path, root.virtual, root.rawPath)
        missing.push(`find: '${shown}': ${strerrorOf(err)}`)
      }
      for (const [path, above] of loops?.() ?? []) {
        missing.push(
          `find: File system loop detected; '${respellOne(path, root.virtual, root.rawPath)}' ` +
            `is part of the same file system loop as '${respellOne(above, root.virtual, root.rawPath)}'.`,
        )
      }
      for (const line of stopped?.() ?? []) missing.push(`find: ${line}`)
      if (quitted?.() === true) break
    }
    if (missing.length > 0) {
      io.stderr = ENC.encode(missing.join('\n') + '\n')
      io.exitCode = 1
    }
  }
  return Promise.resolve([stream(), io])
}

/**
 * A find line walks every mount below its start points, and follows a start
 * point that is a link under `-H` or `-L`: the last of `-P`, `-H` and `-L`
 * typed before the first start point wins, where GNU reads them (findutils
 * 4.10). Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  let follows: Follow = Follow.NONE
  for (const [name] of fl.occurrences(OPERAND, 'P', 'H', 'L')) {
    if (name === OPERAND) break
    follows = name === 'P' ? Follow.NONE : Follow.LAST
  }
  if (fl.asBool('follow')) follows = Follow.LAST
  return new LineFacts({ follows, walks: true, readsSubtree: true })
}
