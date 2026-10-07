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

import { activeCacheManager } from '../../../cache/context.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { modifiedTs } from '../../../core/generic/find.ts'
import { fsStrerror, isEnoent, isEnotdir, isMissError, walkRefusal } from '../../../errors/fs.ts'
import { dotRefusal, linkFollow, statOrEnoent } from '../utils/paths.ts'
import { failureText } from '../../../errors/classify.ts'
import { IOResult } from '../../../io/types.ts'
import type { FindOptions } from '../../../vfs/base.ts'
import { FindParseError } from '../../errors.ts'
import { parseDepth, parseFindExpression, parseMtime, parseSize } from '../find_parse.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { respellOne, respellRaw } from '../../../utils/path.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import {
  bindTree,
  displayPath,
  dropPruned,
  emitStartPath,
  hasLinkChildren,
  optionsTree,
  settlePendingPrunes,
  startBasename,
  unrespellRaw,
  type PredNode,
} from '../find_eval.ts'
import { printfKind } from '../find_printf.ts'
import { pathVisible } from '../../../utils/hidden.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { linkResults } from '../../../core/generic/find.ts'
import { posixPhrase } from '../../../errors/posix.ts'

const ENC = new TextEncoder()

function invalidFindArg(message: string): CommandFnResult {
  return [
    null,
    new IOResult({
      exitCode: 1,
      stderr: ENC.encode(`${message}\n`),
    }),
  ]
}

// The stat probe's path for one display row of a mount.
function rowSpec(row: string, mountPrefix: string): PathSpec {
  return new PathSpec({
    virtual: row,
    directory: row,
    resolved: false,
    vfsPath: mountKey(row, mountPrefix),
  })
}

// The structured row the action layer acts on: the resolved path, spelled
// as it prints.
function matchedPath(row: string, root: PathSpec): PathSpec {
  const virtual = unrespellRaw(row, root.virtual, root.rawPath || root.virtual)
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: mountKey(virtual, mountPrefixOf(root.virtual, root.vfsPath)),
    rawPath: row,
    resolved: true,
  })
}

async function applyMtimeFilter(
  results: string[],
  mtimeMin: number | null,
  mtimeMax: number | null,
  stat: (spec: PathSpec) => Promise<FileStat>,
  mountPrefix: string,
): Promise<string[]> {
  if (mtimeMin === null && mtimeMax === null) return results
  const filtered: string[] = []
  for (const r of results) {
    let st: FileStat
    try {
      st = await stat(rowSpec(r, mountPrefix))
    } catch (err) {
      if (isEnoent(err) || isEnotdir(err)) continue
      throw err
    }
    const mt = modifiedTs(st.modified)
    if (mt === null) continue
    if (mtimeMin !== null && mt < mtimeMin) continue
    if (mtimeMax !== null && mt > mtimeMax) continue
    filtered.push(r)
  }
  return filtered
}

// Epoch-second mtime of one mount-relative row through the overlay-aware
// stat, null when it has none or is gone.
async function rowMtime(
  stat: (spec: PathSpec) => Promise<FileStat>,
  mountPrefix: string,
  row: string,
): Promise<number | null> {
  try {
    return modifiedTs((await stat(rowSpec(displayPath(mountPrefix, row), mountPrefix))).modified)
  } catch (err) {
    if (!isEnoent(err) && !isEnotdir(err)) throw err
    return null
  }
}

function extractNotName(texts: readonly string[]): string | null {
  for (let i = 0; i < texts.length; i++) {
    const pat = texts[i + 2]
    if (texts[i] === '-not' && texts[i + 1] === '-name' && pat !== undefined) {
      return pat
    }
  }
  return null
}

function extractOrNames(name: string | null, texts: readonly string[]): string[] {
  const names: string[] = []
  if (name !== null) names.push(name)
  let i = 0
  while (i < texts.length) {
    const pat = texts[i + 2]
    const isOr = texts[i] === '-or' || texts[i] === '-o'
    if (isOr && texts[i + 1] === '-name' && pat !== undefined) {
      names.push(pat)
      i += 3
    } else {
      i += 1
    }
  }
  return names
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
  options: FindOptions,
  tree: PredNode,
  usesEmpty: boolean,
  mtimeMin: number | null,
  mtimeMax: number | null,
): string[] {
  const results: string[] = []
  if (mtimeMin !== null || mtimeMax !== null) {
    const ts = modifiedTs(start.modified ?? null)
    if (ts === null || Number.isNaN(ts)) return results
    if (mtimeMin !== null && ts < mtimeMin) return results
    if (mtimeMax !== null && ts > mtimeMax) return results
  }
  emitStartPath(results, rstripSlash(root.mountPath) || '/', startBasename(root.virtual), {
    kind: printfKind(start),
    isEmpty: usesEmpty && printfKind(start) === 'f' ? start.size === 0 : usesEmpty ? false : null,
    exists: true,
    tree,
    maxDepth: options.maxDepth ?? null,
    minDepth: options.minDepth ?? null,
    size: start.size ?? null,
    minSize: options.minSize ?? null,
    maxSize: options.maxSize ?? null,
  })
  return results
}

// Results for the directory start point itself, at depth 0.
//
// GNU lists a directory start point before descending into it, so
// `find <dir>` names the directory even when it holds nothing. The generic
// already statted the start point to get here, so it decides this row and
// the backend only has to answer for descendants (see withRootRow for why
// the backend's own row is dropped).
//
// -mtime is deliberately not applied here: the caller either filters every
// row against namespace-aware times afterwards, or pushed the window into
// the backend, and re-testing it against the probe's own stat would drop
// rows a touch had just matched.
function rootDirResults(
  root: PathSpec,
  options: FindOptions,
  tree: PredNode,
  isEmpty: boolean | null,
): string[] {
  const results: string[] = []
  emitStartPath(results, rstripSlash(root.mountPath) || '/', startBasename(root.virtual), {
    kind: 'd',
    isEmpty,
    exists: true,
    tree,
    maxDepth: options.maxDepth ?? null,
    minDepth: options.minDepth ?? null,
    minSize: options.minSize ?? null,
    maxSize: options.maxSize ?? null,
  })
  return results
}

// Replace the backend's row for the start point with the generic's.
//
// Most native find ops emit the start path themselves, and each judged it
// on the only facts it had: ssh calls every directory non-empty, an object
// store calls one empty only when its own listing was empty, and a store
// holding no directory marker reported nothing at all. Merging instead of
// replacing would keep whichever of those a backend happened to say, so the
// row is dropped and the generic's takes its place. Descendants are still
// entirely the backend's answer.
//
// Compared with trailing slashes stripped, because a directory key is
// spelled both ways across backends (chroma reports the root as `<root>/`).
function withRootRow(rows: string[], display: string, root: string[]): string[] {
  return rows
    .filter((r) => (rstripSlash(r) || '/') !== display)
    .concat(root.length > 0 ? [display] : [])
}

// The strerror of a start point statPath found nothing at. statPath answers
// null for both ways a lookup fails, because every other caller of it treats
// them alike, while GNU names the one its stat met. So the mount's own stat
// is asked which, on the failure path only: a start point under a plain file
// is ENOTDIR. Mirrors _missing_start in find.py.
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
  readonly follow: boolean
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
    follow: fl.asBool('L'),
  }
}

export function findGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  find: (root: PathSpec, options: FindOptions) => Promise<string[]>,
  stat?: (spec: PathSpec) => Promise<FileStat>,
  dirEmpty?: (spec: PathSpec) => Promise<boolean>,
  unreadable?: () => string[],
  unstatted?: () => [string, unknown][],
  // A walker already evaluates times in its predicate tree. Its raw stat is
  // needed only to distinguish ENOTDIR from ENOENT at a missing start point.
  missingStat?: (spec: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
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
  let maxDepth: number | null = null
  let minDepth: number | null = null
  let minSize: number | null = null
  let maxSize: number | null = null
  let mtimeMin: number | null = null
  let mtimeMax: number | null = null
  try {
    maxDepth = maxDepthFlag !== null ? parseDepth(maxDepthFlag, '-maxdepth') : null
    minDepth = minDepthFlag !== null ? parseDepth(minDepthFlag, '-mindepth') : null
    ;[minSize, maxSize] = sizeFlag !== null ? parseSize(sizeFlag) : [null, null]
    ;[mtimeMin, mtimeMax] = mtimeFlag !== null ? parseMtime(mtimeFlag) : [null, null]
  } catch (err) {
    if (err instanceof FindParseError) return Promise.resolve(invalidFindArg(err.message))
    throw err
  }
  const nameExclude = extractNotName(texts)
  const orNames = extractOrNames(nameFlag, texts)
  const emptyFlag = parsed.empty
  const expr = texts.length > 0 ? parseFindExpression(texts) : null
  // With a stat wired, the mtime window is applied by the overlay-
  // aware post-filter below, not pushed into the core: backend cores
  // only see native times and would drop files whose mtime lives in
  // the namespace (touch results, observed writes).
  const pushMtime = stat === undefined
  const effMtimeMin = expr !== null ? expr.mtimeMin : mtimeMin
  const effMtimeMax = expr !== null ? expr.mtimeMax : mtimeMax
  const options: FindOptions =
    expr !== null
      ? {
          tree: expr.tree,
          ...(expr.maxDepth !== null ? { maxDepth: expr.maxDepth } : {}),
          ...(expr.minDepth !== null ? { minDepth: expr.minDepth } : {}),
          ...(expr.minSize !== null ? { minSize: expr.minSize } : {}),
          ...(expr.maxSize !== null ? { maxSize: expr.maxSize } : {}),
          ...(pushMtime && expr.mtimeMin !== null ? { mtimeMin: expr.mtimeMin } : {}),
          ...(pushMtime && expr.mtimeMax !== null ? { mtimeMax: expr.mtimeMax } : {}),
          ...(expr.usesEmpty ? { empty: true } : {}),
        }
      : {
          name: nameFlag,
          iname: inameFlag,
          type: findType,
          ...(maxDepth !== null ? { maxDepth } : {}),
          ...(minDepth !== null ? { minDepth } : {}),
          ...(minSize !== null ? { minSize } : {}),
          ...(maxSize !== null ? { maxSize } : {}),
          ...(pushMtime && mtimeMin !== null ? { mtimeMin } : {}),
          ...(pushMtime && mtimeMax !== null ? { mtimeMax } : {}),
          ...(nameExclude !== null ? { nameExclude } : {}),
          ...(pathFlag !== null ? { pathPattern: pathFlag } : {}),
          ...(orNames.length > 1 ? { orNames } : {}),
          ...(emptyFlag ? { empty: true } : {}),
        }
  const cacheManager = activeCacheManager()
  const matchedRuns: PathSpec[][] = []
  const io = new IOResult({ matchedRuns })
  async function* stream(): AsyncGenerator<Uint8Array> {
    const missing: string[] = []
    // One run per start point, in operand order, empty for one that matched
    // nothing or is missing: the action layer acts on each traversal on its
    // own and reads a row's start point off its run (-printf's %P and %d).
    for (const root of targets) {
      const run: PathSpec[] = []
      matchedRuns.push(run)
      // `-path` matches the row as printed; stamp the mount prefix and the
      // operand's spelling onto path nodes before the backend walks
      // mount-relative keys (#396). Bound per start point: options is
      // shared by every one of them and must stay unbound.
      const prefix = mountPrefixOf(root.virtual, root.vfsPath)
      const tree = bindTree(optionsTree(options), prefix, root.virtual, root.rawPath)
      const rootOptions: FindOptions = { ...options, tree }
      const rootIsLink = (opts.ns?.links ?? null)?.statAt(root.virtual) != null
      // What the start point is decides which walk is even possible, so it
      // is resolved once, ahead of all of them: a symlink has no backend
      // inode (linkResults reports it), a non-directory has no subtree, and
      // nothing at all is GNU's diagnostic. Statted through the dispatcher,
      // so a start point the router already resolved into another mount
      // answers there rather than on this command's mount.
      // The probe asks both channels a backend can answer on, so a directory
      // that exists only as its children still reports as one and null means
      // nothing is there (see resolvePathStat). That is what makes the
      // missing case answerable above every backend rather than only where
      // one wires a stat.
      const startStat = opts.statPath
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
        const refusal = await dotRefusal(statOrEnoent(startStat), root, linkFollow(opts.ns?.links))
        if (refusal !== null) {
          const label = root.rawPath !== '' ? root.rawPath : root.virtual
          missing.push(`find: '${label}': ${fsStrerror(refusal) ?? posixPhrase('ENOENT')}`)
          continue
        }
      }
      let startIsDir = false
      if (startStat !== undefined && !rootIsLink) {
        let start: FileStat | null
        try {
          start = await startStat(root.virtual)
        } catch (err) {
          // A start point the door refuses to stat is GNU's own
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
          missing.push(`find: '${label}': ${await missingStartDetail(root, missingStat ?? stat)}`)
          continue
        }
        const cachedSize = start.size === null ? await cacheManager?.cachedSize(root) : null
        if (cachedSize != null) start = start.with({ size: cachedSize })
        if (start.type !== FileType.DIRECTORY && root.rawPath.endsWith('/')) {
          // POSIX reads `x/` as `x/.`, so an operand typed with a trailing
          // slash has to name a directory; GNU refuses the rest with
          // ENOTDIR rather than reporting the entry itself.
          missing.push(`find: '${root.rawPath}': Not a directory`)
          continue
        }
        if (start.type !== FileType.DIRECTORY) {
          const rows = startPointResults(
            root,
            start,
            rootOptions,
            optionsTree(rootOptions),
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
            for (const r of added) run.push(matchedPath(r, root))
          }
          continue
        }
        startIsDir = true
      }
      // The directory row is known before any native op fetches descendants.
      // Yielding it first lets a closed pipe prevent that remote traversal.
      const usesEmptyEarly = expr !== null ? expr.usesEmpty : emptyFlag
      let first: string[] = []
      if (
        startIsDir &&
        !usesEmptyEarly &&
        !(pushMtime && (effMtimeMin !== null || effMtimeMax !== null))
      ) {
        const rootRows =
          rootDirResults(root, rootOptions, optionsTree(rootOptions), null).length > 0
            ? [rstripSlash(root.virtual) || '/']
            : []
        const checked =
          stat !== undefined
            ? await applyMtimeFilter(rootRows, effMtimeMin, effMtimeMax, stat, prefix)
            : rootRows
        first = respellRaw(
          checked.filter((row) => pathVisible(opts.ns?.visibility, PathSpec.fromStrPath(row))),
          root.virtual,
          root.rawPath,
        )
        for (const row of first) yield ENC.encode(row + '\n')
      }
      let keys: string[]
      try {
        keys = rootIsLink ? [] : await find(root, rootOptions)
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
        missing.push(`find: '${shown}': ${failureText(err)}`)
      }
      const rootKey = rstripSlash(root.mountPath) || '/'
      const rootMatches: string[] = []
      for (const key of keys) {
        const displayPath =
          root.virtual === '/'
            ? key
            : rootKey === '/' && key === '/'
              ? rstripSlash(root.virtual)
              : rstripSlash(root.virtual) + key.slice(rootKey === '/' ? 0 : rootKey.length)
        rootMatches.push(displayPath)
      }
      // GNU lists a directory start point itself before descending into it, so
      // it is named even when it holds nothing. Decided here rather than by
      // each backend, which read existence off its own listing. A pushed-down
      // mtime window is the one case left to the backend: this row never
      // passed through it.
      const mtimePushed = pushMtime && (effMtimeMin !== null || effMtimeMax !== null)
      // Emptiness is the one fact this row needs that a caller can decline to
      // offer (a bespoke wrapper wires no readdir), and that caller's op may
      // know it. Left alone in that case, so a backend's answer is never
      // traded for "unknown".
      const usesEmpty = expr !== null ? expr.usesEmpty : emptyFlag
      const canProbe = !usesEmpty || dirEmpty !== undefined
      let rows = rootMatches
      if (startIsDir && !mtimePushed && canProbe) {
        let rootEmpty = usesEmpty && dirEmpty !== undefined ? await dirEmpty(root) : null
        // A symlink is namespace state no backend readdir can see, so a
        // directory holding only one would read as empty. GNU counts the
        // link as an entry.
        if (rootEmpty === true) rootEmpty = !hasLinkChildren(opts.ns?.links, root.virtual)
        rows = withRootRow(
          rootMatches,
          root.virtual === '/' ? '/' : rstripSlash(root.virtual),
          rootDirResults(root, rootOptions, optionsTree(rootOptions), rootEmpty),
        )
      }
      const filtered =
        stat !== undefined
          ? await applyMtimeFilter(rows, effMtimeMin, effMtimeMax, stat, prefix)
          : rows
      const rootPath = root.virtual === '/' ? '/' : rstripSlash(root.virtual)
      const withLinks = filtered.concat(
        await linkResults(
          opts.ns?.links ?? null,
          rootPath,
          prefix,
          stripSlash(rootKey),
          optionsTree(rootOptions),
          expr !== null ? expr.minDepth : minDepth,
          expr !== null ? expr.maxDepth : maxDepth,
          expr !== null ? expr.minSize : minSize,
          expr !== null ? expr.maxSize : maxSize,
          effMtimeMin,
          effMtimeMax,
          parsed.follow,
        ),
      )
      withLinks.sort(compareCodePoints)
      // What -prune reached is known only once every row has been judged: a
      // flat listing meets a child before its parent, so the ledger the tree
      // kept is applied here, after the backend and the link merge.
      if (stat !== undefined) {
        await settlePendingPrunes(tree, (key) => rowMtime(stat, prefix, key))
      }
      const unpruned = dropPruned(withLinks, tree, prefix)
      // Hidden rows drop here, above the native-op/walk fork and after
      // the link merge, so a mount's visibility behavior cannot depend
      // on whether its backend ships a native find op.
      const visibleRows = unpruned.filter((row) =>
        pathVisible(opts.ns?.visibility, PathSpec.fromStrPath(row)),
      )
      const added = respellRaw(visibleRows, root.virtual, root.rawPath)
      for (const row of added) if (!first.includes(row)) yield ENC.encode(row + '\n')
      for (const r of added) run.push(matchedPath(r, root))
    }
    if (missing.length > 0) {
      io.stderr = ENC.encode(missing.join('\n') + '\n')
      io.exitCode = 1
    }
  }
  return Promise.resolve([stream(), io])
}
