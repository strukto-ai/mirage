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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { modifiedTs } from '../../../core/generic/find.ts'
import { isEnoent } from '../../../utils/errors.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { FindParseError } from '../../errors.ts'
import { parseDepth, parseFindExpression, parseMtime, parseSize } from '../find_parse.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { respellRaw } from '../../../utils/path.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import {
  emitStartPath,
  hasLinkChildren,
  keep,
  optionsTree,
  prefixPathNodes,
  startBasename,
  unrespellRaw,
  type FindEntry,
  type PredNode,
} from '../find_eval.ts'
import { expandPrintf, printfKind, printfNeedsStat, type PrintfStatFacts } from '../find_printf.ts'
import { identityOf } from '../utils/identity.ts'
import type { LinkView } from '../../../ops/types.ts'
import { pathAllowed } from '../../../context/session_context.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

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
    const spec = new PathSpec({
      virtual: r,
      directory: r,
      resolved: false,
      resourcePath: mountKey(r, mountPrefix),
    })
    let st: FileStat
    try {
      st = await stat(spec)
    } catch (err) {
      if (isEnoent(err)) continue
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

// Namespace symlinks under the search root that match the expression.
//
// Symlinks live in the namespace, not in any backend, so a backend's
// find never sees them. Merging them here, above every backend, is what
// keeps a mount's symlink behavior from depending on its backend.
//
// GNU find without -L reports the link itself and never walks through
// it, so a link is kind 'l'. Its size is the target string's length,
// which is what -size compares, and it carries the link's own mtime.
//
// Under -L a link is classified by what it points at instead: a link to
// a file tests as 'f', a link to a directory as 'd', and only a dangling
// link stays 'l' (GNU reports the link itself when the target cannot be
// stat'd). -size and -mtime then compare the target's stat, since that
// is the file being reported.
export async function linkResults(
  links: LinkView | null,
  searchRoot: string,
  prefix: string,
  searchKey: string,
  tree: PredNode,
  minDepth: number | null,
  maxDepth: number | null,
  minSize: number | null,
  maxSize: number | null,
  mtimeMin: number | null,
  mtimeMax: number | null,
  follow: boolean,
): Promise<string[]> {
  if (links === null) return []
  const out: string[] = []
  // GNU find's default is -P: a start point that is itself a symlink is
  // reported as the link and never walked through. The backend cannot
  // see it at all, so the subtree scan (which only covers entries
  // *under* the root) would miss it.
  const entries = [...links.subtree(searchRoot)]
  const own = links.statAt(searchRoot)
  if (own !== null) entries.push([searchRoot, own])
  for (const [path, ownStat] of entries) {
    let st = ownStat
    let kind: FindEntry['kind'] = 'l'
    if (follow) {
      const target = await links.targetStat(path)
      if (target !== null) {
        kind = printfKind(target)
        st = target
      }
    }
    const key = prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
    const rel = stripSlash(key)
    const depth =
      searchKey !== ''
        ? rel === searchKey
          ? 0
          : rel.split('/').length - searchKey.split('/').length
        : rel === ''
          ? 0
          : rel.split('/').length
    if (maxDepth !== null && depth > maxDepth) continue
    const entry: FindEntry = { key, name: path.split('/').pop() ?? path, kind, depth }
    if (!keep(entry, tree, minDepth)) continue
    const size = st.size ?? 0
    if (minSize !== null && size < minSize) continue
    if (maxSize !== null && size > maxSize) continue
    if (mtimeMin !== null || mtimeMax !== null) {
      // `modifiedTs` is the helper the rest of this file uses. A bare
      // Date.parse gives NaN for a date-only or malformed stamp, which the
      // `=== null` guard below does not catch, so every comparison came out
      // false and the entry was kept -- where Python drops it.
      const ts = modifiedTs(st.modified)
      if (ts === null) continue
      if (mtimeMin !== null && ts < mtimeMin) continue
      if (mtimeMax !== null && ts > mtimeMax) continue
    }
    out.push(path)
  }
  return out
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
    isEmpty:
      usesEmpty && printfKind(start) === 'f' ? (start.size ?? 0) === 0 : usesEmpty ? false : null,
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

export async function findGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  find: (root: PathSpec, options: FindOptions) => Promise<string[]>,
  stat?: (spec: PathSpec) => Promise<FileStat>,
  dirEmpty?: (spec: PathSpec) => Promise<boolean>,
  unreadable?: () => string[],
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('find'))
  const nameFlag = fl.asStr('name') ?? null
  const inameFlag = fl.asStr('iname') ?? null
  const typeFlag = fl.asStr('type') ?? null
  const pathFlag = fl.asStr('path') ?? null
  const maxDepthFlag = fl.asStr('maxdepth') ?? null
  const minDepthFlag = fl.asStr('mindepth') ?? null
  const sizeFlag = fl.asStr('size') ?? null
  const mtimeFlag = fl.asStr('mtime') ?? null
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            resourcePath: '',
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
    if (err instanceof FindParseError) return invalidFindArg(err.message)
    throw err
  }
  const nameExclude = extractNotName(texts)
  const orNames = extractOrNames(nameFlag, texts)
  const emptyFlag = fl.asBool('empty')
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
  const matches: string[] = []
  const missing: string[] = []
  const printfFmt = expr !== null ? expr.printf : null
  const printfPairs: [string, PathSpec][] = []
  for (const root of targets) {
    // `-path` matches the display path as printed; stamp the mount
    // prefix onto path nodes before the backend walks mount-relative
    // keys (#396).
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const rootOptions: FindOptions = {
      ...options,
      tree: prefixPathNodes(optionsTree(options), prefix),
    }
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
    let startIsDir = false
    if (startStat !== undefined && !rootIsLink) {
      const start = await startStat(root.virtual)
      if (start === null) {
        // GNU names each start point it cannot stat, keeps going with the
        // rest, and exits 1. Reported as the operand was typed, falling
        // back to the resolved path for a synthesized root.
        const label = root.rawPath !== '' ? root.rawPath : root.virtual
        missing.push(`find: '${label}': No such file or directory`)
        continue
      }
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
          matches.push(...added)
          for (const r of added) printfPairs.push([r, root])
        }
        continue
      }
      startIsDir = true
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
        fl.asBool('L'),
      ),
    )
    withLinks.sort(compareCodePoints)
    // Hidden rows drop here, above the native-op/walk fork and after
    // the link merge, so a mount's visibility behavior cannot depend
    // on whether its backend ships a native find op.
    const visibleRows = withLinks.filter((row) => pathAllowed(row))
    const added = respellRaw(visibleRows, root.virtual, root.rawPath)
    matches.push(...added)
    for (const r of added) printfPairs.push([r, root])
  }
  if (printfFmt !== null) {
    return renderPrintfRows(printfPairs, printfFmt, stat, opts, missing)
  }
  // Start points print in operand order (GNU); each root's rows were
  // sorted above, and a global sort here would interleave them. The
  // rows ride out as one run per root, so the action layer can order
  // and act on each traversal on its own.
  const matchedRuns: PathSpec[][] = []
  let lastRoot: PathSpec | null = null
  for (const [row, root] of printfPairs) {
    if (root !== lastRoot) {
      matchedRuns.push([])
      lastRoot = root
    }
    const virtual = unrespellRaw(row, root.virtual, root.rawPath || root.virtual)
    matchedRuns[matchedRuns.length - 1]?.push(
      new PathSpec({
        virtual,
        directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
        resourcePath: mountKey(virtual, mountPrefixOf(root.virtual, root.resourcePath)),
        rawPath: row,
        resolved: true,
      }),
    )
  }
  const out: ByteSource = ENC.encode(matches.length ? matches.join('\n') + '\n' : '')
  if (missing.length > 0) {
    return [
      out,
      new IOResult({ matchedRuns, stderr: ENC.encode(missing.join('\n') + '\n'), exitCode: 1 }),
    ]
  }
  return [out, new IOResult({ matchedRuns })]
}

async function printfStat(
  row: string,
  root: PathSpec,
  stat: ((spec: PathSpec) => Promise<FileStat>) | undefined,
  opts: CommandOpts,
): Promise<PrintfStatFacts | null> {
  const virtual = unrespellRaw(row, root.virtual, root.rawPath !== '' ? root.rawPath : root.virtual)
  const links = opts.ns?.links ?? null
  const linkRow = links?.statAt(virtual)
  if (links !== null && linkRow !== undefined && linkRow !== null) {
    // %Y reads the target through the workspace, so a link into another
    // mount classifies correctly and a dangling one reads N.
    const target = await links.targetStat(virtual)
    return {
      size: linkRow.size ?? 0,
      kind: 'l',
      mtimeEpoch: modifiedTs(linkRow.modified ?? null) ?? 0,
      mode: linkRow.mode,
      targetKind: target === null ? 'N' : printfKind(target),
      uid: linkRow.uid,
      gid: linkRow.gid,
    }
  }
  let st: FileStat | null = null
  if (stat !== undefined) {
    const prefix = mountPrefixOf(root.virtual, root.resourcePath)
    const spec = new PathSpec({
      virtual,
      directory: virtual,
      resolved: false,
      resourcePath: mountKey(virtual, prefix),
    })
    try {
      st = await stat(spec)
    } catch {
      st = null
    }
  } else if (opts.statPath !== undefined) {
    // The dispatcher probe answers for every backend, including the ones
    // that wire no cheap local stat (an object store); it is the same
    // channel the start-point classifier uses.
    st = await opts.statPath(virtual)
  }
  if (st === null) return null
  return {
    size: st.size ?? 0,
    kind: printfKind(st),
    mtimeEpoch: modifiedTs(st.modified ?? null) ?? 0,
    mode: st.mode,
    targetKind: null,
    uid: st.uid,
    gid: st.gid,
  }
}

// Render matched rows through a -printf format. Stats are fetched per row
// only when the format reads one (%s %y %m %M %T), through the same
// overlay-aware channel the -mtime filter uses, with namespace links
// answered first since a link row has no backend inode. Warning lines
// (unrecognized directives) ride stderr without touching the exit code,
// GNU's behavior; missing start points keep forcing exit 1. Mirrors the
// Python render_printf_rows.
async function renderPrintfRows(
  pairs: [string, PathSpec][],
  fmt: string,
  stat: ((spec: PathSpec) => Promise<FileStat>) | undefined,
  opts: CommandOpts,
  missing: string[],
): Promise<CommandFnResult> {
  const warnings: string[] = []
  const needs = printfNeedsStat(fmt)
  const parts: string[] = []
  for (const [row, root] of pairs) {
    const st = needs ? await printfStat(row, root, stat, opts) : null
    const base = root.rawPath !== '' ? root.rawPath : root.virtual
    parts.push(expandPrintf(fmt, row, base, st, warnings, identityOf(opts)))
  }
  const err = [...missing, ...warnings]
  const io = new IOResult({
    stderr: err.length > 0 ? ENC.encode(err.join('\n') + '\n') : null,
    exitCode: missing.length > 0 ? 1 : 0,
  })
  return [ENC.encode(parts.join('')), io]
}
