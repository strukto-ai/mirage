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

import { pathAllowed } from '../../context/session_context.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import { MountCommandUnsupported, type MountRegistry } from '../mount/registry.ts'
import { ExecutionNode } from '../types.ts'
import { respellOne } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { keep } from '../../commands/builtin/find_eval.ts'
import { parseFindExpression, type FindExpr } from '../../commands/builtin/find_parse.ts'
import { FindParseError } from '../../commands/errors.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import type { RunSingle } from '../../commands/builtin/generic/crossmount/types.ts'
import type { NamespaceView, StatPath } from '../../ops/types.ts'
import { inMtimeWindow } from '../../utils/dates.ts'
import { modifiedTs } from '../../core/generic/find.ts'
import { mergeDuBlocks } from '../../commands/builtin/generic/crossmount/fanout/du.ts'
import { compareCodePoints } from '../../utils/sort.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

// `tree` is deliberately absent: its output is one document (root line,
// drawing, summary), so a second per-mount block would print a second of
// each. It crosses the boundary inside the generic instead.
const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'du'])

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
}

function depthFlagValue(raw: FlagValue | null): number | null {
  const one = Array.isArray(raw) ? (raw[0] ?? null) : raw
  if (one === null || typeof one === 'boolean') return null
  const n = Number(one)
  return Number.isNaN(n) ? null : n
}

// The descendant mount roots that are directories.
//
// A mount root is not always one: `/.bash_history` is a whole mount serving a
// single file. du's merge has to tell them apart because a directory with no
// content still earns GNU's `0` row while a file only shows under `-a`, and
// rendered du output cannot say which it was looking at. Without a dispatcher
// the question cannot be asked, and the merge falls back to inferring from the
// row shape.
async function mountDirs(
  descendants: readonly MountEntry[],
  statPath: StatPath | null,
): Promise<string[]> {
  if (statPath === null) return []
  const out: string[] = []
  for (const m of descendants) {
    const root = rstripSlash(m.prefix) || '/'
    const stat = await statPath(root)
    if (stat !== null && stat.type === FileType.DIRECTORY) out.push(root)
  }
  return out
}

/**
 * Descendant mounts the current session may see.
 *
 * A fan-out rooted above a session boundary must not walk into an
 * ungranted mount: enumerating it through the raw registry is exactly
 * how `grep -r x /` leaked a walled-off mount's contents. The filter
 * matches the door's structure merge, so the fan-out stays an
 * unobservable optimization.
 */
function allowedDescendants(registry: MountRegistry, path: string): MountEntry[] {
  return registry.descendantMounts(path).filter((m) => pathAllowed('/' + stripSlash(m.prefix)))
}

// The descendants `ls -R` should render a block for.
//
// A mount root is not always a directory (`/.bash_history` is a whole
// mount serving one file), and GNU lists a file that happens to be a
// mountpoint as an ordinary row of its parent with no block of its own —
// pinned on coreutils 9.7 over a `mount --bind` of one file onto another.
// The parent's listing already carries that row, because ls stats every
// child mount through this same dispatcher, so a sub-run would print the
// name a second time.
//
// Only a *confirmed* non-directory is dropped: a root the dispatcher
// cannot stat keeps its block rather than vanishing on a failed probe, and
// without a dispatcher at all the question cannot be asked and every
// descendant stands.
async function lsBlockMounts(
  descendants: readonly MountEntry[],
  statPath: StatPath | null,
): Promise<MountEntry[]> {
  if (statPath === null) return [...descendants]
  const kept: MountEntry[] = []
  for (const m of descendants) {
    const stat = await statPath(rstripSlash(m.prefix) || '/')
    if (stat === null || stat.type === FileType.DIRECTORY) kept.push(m)
  }
  return kept
}

export function shouldFanOut(
  cmdName: string,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  registry: MountRegistry,
): boolean {
  if (paths.length === 0 || paths[0] === undefined) return false
  // Gated on the raw registry, not the session view: with every
  // descendant ungranted, single-mount dispatch would serve the parent
  // backend's keys shadowed under a hidden mount's prefix, and only the
  // fan-out's shadow filter drops those. Execution still runs the
  // allowed descendants only.
  if (registry.descendantMounts(paths[0].virtual).length === 0) return false
  if (TRAVERSAL_CMDS.has(cmdName)) return true
  if (cmdName === 'grep') {
    return flagKwargs.r === true || flagKwargs.R === true || flagKwargs.recursive === true
  }
  // ripgrep recurses directories by default; no flag to check.
  if (cmdName === 'rg') return true
  if (cmdName === 'ls') {
    return flagKwargs.R === true
  }
  return false
}

function adjustDepthFlags(
  flagKwargs: Record<string, FlagValue>,
  parentPath: string,
  mountPrefix: string,
): Record<string, FlagValue> | null {
  const parentDepth = pathSegments(parentPath).length
  const mountDepth = pathSegments(mountPrefix).length
  const delta = mountDepth - parentDepth
  const out: Record<string, FlagValue> = { ...flagKwargs }
  const first = (v: string | boolean | number | string[]): string | boolean | number =>
    Array.isArray(v) ? (v[0] ?? '') : v
  if ('maxdepth' in out) {
    const orig = Number(first(out.maxdepth))
    if (!Number.isNaN(orig)) {
      const md = orig - delta
      if (md < 0) return null
      out.maxdepth = String(md)
    }
  }
  if ('mindepth' in out) {
    const orig = Number(first(out.mindepth))
    if (!Number.isNaN(orig)) {
      out.mindepth = String(Math.max(0, orig - delta))
    }
  }
  return out
}

function adjustDepthTexts(
  texts: readonly string[],
  parentPath: string,
  mountPrefix: string,
): string[] {
  const delta = pathSegments(mountPrefix).length - pathSegments(parentPath).length
  const out = [...texts]
  if (delta === 0) return out
  let i = 0
  while (i < out.length - 1) {
    const tok = out[i]
    if (tok === '-maxdepth' || tok === '-mindepth') {
      const val = Number(out[i + 1])
      if (!Number.isNaN(val)) {
        out[i + 1] = tok === '-maxdepth' ? String(val - delta) : String(Math.max(0, val - delta))
      }
      i += 2
      continue
    }
    i += 1
  }
  return out
}

// Entries print in the operand's typed spelling (`raw`) like every
// other line of the walk. The namespace-only ancestors between the
// start and each mount root (`/ghost` above a mount at `/ghost/deep`)
// get a row too: no backend walk covers them, yet `ls` lists them
// through the door's structure merge, so find must agree.
async function synthesizeFindMountEntries(
  targetPath: string,
  descendants: readonly MountEntry[],
  texts: readonly string[],
  raw: string,
  statPath: StatPath | null,
): Promise<PathSpec[]> {
  let expr: FindExpr
  try {
    expr = parseFindExpression([...texts])
  } catch (err) {
    if (err instanceof FindParseError) return []
    throw err
  }
  const tree = expr.tree
  const maxDepth = expr.maxDepth
  const minDepth = expr.minDepth ?? 0
  const parentDepth = pathSegments(targetPath).length
  const parentBase = rstripSlash(targetPath)
  const seen = new Set<string>()
  const out: PathSpec[] = []
  for (const m of descendants) {
    const prefixNoSlash = rstripSlash(m.prefix)
    const ancestors: string[] = []
    let parent = prefixNoSlash.slice(0, prefixNoSlash.lastIndexOf('/'))
    while (parent !== '' && parent !== parentBase) {
      ancestors.push(parent)
      parent = parent.slice(0, parent.lastIndexOf('/'))
    }
    for (const candidate of [...ancestors.reverse(), prefixNoSlash]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const depth = pathSegments(candidate).length - parentDepth
      if (maxDepth !== null && depth > maxDepth) continue
      const segs = pathSegments(candidate)
      const base = segs[segs.length - 1] ?? candidate
      if (!keep({ key: candidate, name: base, kind: 'd', depth }, tree, minDepth)) continue
      // A time window (-newermt, -newer) lives beside the tree: the
      // candidate is statted and held to it the way the generic holds every
      // real row, a future cutoff excluding the mount points too.
      if ((expr.mtimeMin !== null || expr.mtimeMax !== null) && statPath !== null) {
        const st = await statPath(candidate)
        if (st === null || !inMtimeWindow(modifiedTs(st.modified), expr.mtimeMin, expr.mtimeMax)) {
          continue
        }
      }
      out.push(
        new PathSpec({
          virtual: candidate,
          directory: candidate,
          resourcePath: '',
          resolved: true,
          rawPath: respellOne(candidate, targetPath, raw),
        }),
      )
    }
  }
  return out
}

// Drop whole `ls -R` groups whose header names a nested mount.
//
// `ls -R` renders `PATH:`, then that directory's bare names, with a blank
// line between groups. Reading a path off every line drops the header and
// keeps the names, so a shadowed directory's entries land at the end of
// the previous group, which is how `leftover.txt` came to be listed as a
// child of `/base`.
function dropShadowedLsGroups(text: string, descendantPrefixes: readonly string[]): string[] {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    const header = line.endsWith(':') ? line.slice(0, -1) : null
    if (header?.startsWith('/') === true) {
      skipping = descendantPrefixes.some((pre) => header === pre || header.startsWith(pre + '/'))
      if (skipping) {
        // The blank line ahead of a dropped group would otherwise be left
        // dangling at the end of the block.
        if (kept.at(-1) === '') kept.pop()
        continue
      }
    } else if (skipping) {
      continue
    }
    kept.push(line)
  }
  while (kept.at(-1) === '') kept.pop()
  return kept
}

// Drop lines whose path falls under any descendant mount prefix.
//
// `du` renders SIZE\tPATH, so its path is everything after the first
// tab; `ls -R` renders groups and is filtered a group at a time; for the
// path-first formats (find, grep) the path is the start of the line up to
// the first tab or colon. Lines whose path does not start with `/` are
// passed through.
export async function filterUnderPrefixes(
  stdout: ByteSource,
  descendantPrefixes: readonly string[],
  cmdName: string,
): Promise<Uint8Array> {
  const data = await materialize(stdout)
  const text = new TextDecoder().decode(data)
  if (cmdName === 'ls') {
    const grouped = dropShadowedLsGroups(text, descendantPrefixes)
    if (grouped.length === 0) return new Uint8Array()
    return new TextEncoder().encode(grouped.join('\n') + '\n')
  }
  const outLines: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let path = line
    if (cmdName === 'du') {
      const tab = line.indexOf('\t')
      path = tab >= 0 ? line.slice(tab + 1) : line
    } else {
      for (const sep of ['\t', ':']) {
        const idx = path.indexOf(sep)
        if (idx >= 0) {
          path = path.slice(0, idx)
          break
        }
      }
    }
    if (path.startsWith('/')) {
      let shadowed = false
      for (const pre of descendantPrefixes) {
        if (path === pre || path.startsWith(pre + '/')) {
          shadowed = true
          break
        }
      }
      if (shadowed) continue
    }
    outLines.push(line)
  }
  if (outLines.length === 0) return new Uint8Array()
  return new TextEncoder().encode(outLines.join('\n') + '\n')
}

export async function fanOutTraversal(
  cmdName: string,
  paths: readonly PathSpec[],
  texts: readonly string[],
  flagKwargs: Record<string, FlagValue>,
  registry: MountRegistry,
  primaryMount: MountEntry,
  cwd: string,
  cmdStr: string,
  stdin: ByteSource | null,
  ensureOpen: ((resource: Resource) => Promise<void>) | undefined,
  // The name plane's facts, offered whole to every sub-run. The mount
  // boundaries, because a rollup total cannot be repaired by line
  // filtering: du must exclude a shadowed subtree while it is
  // accounting, not after it has rendered. The symlinks, for the same
  // reason the single-mount path offers them: a sub-run that never
  // receives them reports a tree with every link missing, and a nested
  // mount is not a reason for `find` to stop seeing one.
  ns?: NamespaceView,
  statPath: StatPath | null = null,
): Promise<Result> {
  const targetPath = paths[0]?.virtual ?? cwd
  let descendants = allowedDescendants(registry, targetPath)
  if (cmdName === 'ls') descendants = await lsBlockMounts(descendants, statPath)
  // The shadow filter keeps the raw list on purpose: a mount the
  // session cannot see still shadows the primary backend's keys under
  // its prefix, the walk just never descends into it.
  const descendantPrefixes = registry.descendantMounts(targetPath).map((m) => rstripSlash(m.prefix))

  // A nested mount's bytes belong to every directory above it, so du's
  // blocks are folded into one tree rather than concatenated
  // (`mergeDuBlocks`). The runs are asked for every row in absolute
  // spelling and exact bytes, because the merge needs the leaves back: -a
  // keeps the file rows, -s would collapse them, a depth limit would prune
  // them, and humanized sizes cannot be re-summed. Every one of those is
  // then applied once, centrally.
  const duMerge = cmdName === 'du'
  const duOpts = {
    all: flagKwargs.a === true,
    summarize: flagKwargs.s === true,
    total: flagKwargs.c === true,
    human: flagKwargs.h === true,
    maxDepth: depthFlagValue(flagKwargs.max_depth ?? null),
    separateDirs: flagKwargs.separate_dirs === true,
  }
  let flags = flagKwargs
  if (duMerge) {
    const rest = { ...flagKwargs }
    delete rest.max_depth
    flags = { ...rest, a: true, s: false, c: false, h: false, separate_dirs: false }
  }

  const allStdout: Uint8Array[] = []
  let findMatches: PathSpec[][] = []
  let findMatchesComplete = true
  let mergedIo = new IOResult()
  let finalExit = 0
  let successSeen = false

  const mountsToRun: MountEntry[] = [primaryMount, ...descendants]
  for (const mount of mountsToRun) {
    let subPaths: PathSpec[]
    let subFlags: Record<string, FlagValue>
    let subTexts: string[]
    if (mount === primaryMount) {
      // The du merge re-spells centrally, so the runs answer in absolute
      // virtual paths: a relative operand would otherwise come back
      // already spelled and could not be rebased onto the tree the
      // rollup builds.
      const head = paths[0]
      subPaths =
        duMerge && head !== undefined
          ? [
              new PathSpec({
                virtual: head.virtual,
                directory: head.directory,
                resourcePath: head.resourcePath,
                resolved: head.resolved,
                rawPath: targetPath,
              }),
              ...paths.slice(1),
            ]
          : [...paths]
      subFlags = { ...flags }
      subTexts = [...texts]
    } else {
      const adjusted = adjustDepthFlags(flags, targetPath, mount.prefix)
      if (adjusted === null) continue
      subFlags = adjusted
      if (cmdName === 'rg') {
        // A tree search labels every hit; a descendant mount whose root
        // is a single file would otherwise drop the filename (rg labels
        // only multi-file or -H runs).
        subFlags = { ...subFlags, H: true }
      }
      subTexts = adjustDepthTexts(texts, targetPath, mount.prefix)
      const mountRoot = rstripSlash(mount.prefix) || '/'
      // The descendant operand keeps the traversal root's typed spelling
      // (grep -r . -> ./ram/...; the synthetic bare no-operand form ->
      // ram/...); an absolute root leaves it absolute, the pre-existing
      // output shape.
      subPaths = [
        new PathSpec({
          virtual: mountRoot,
          directory: mountRoot,
          resourcePath: mountKey(mountRoot, rstripSlash(mount.prefix)),
          rawPath: duMerge
            ? mountRoot
            : respellOne(mountRoot, targetPath, paths[0]?.rawPath ?? targetPath),
        }),
      ]
    }
    // Errors propagate, mirroring python: a mount that cannot open or
    // whose command raises is a real failure, never a silently missing
    // slice of the aggregate. Unserved commands return 127 (below).
    if (ensureOpen !== undefined) {
      await ensureOpen(mount.resource)
    }
    // The child-mount names and the dispatcher-backed start-point stat.
    // A start point only the namespace serves (a nested mount's
    // ancestor) has no backend listing, so without them the primary run
    // reports the operand missing.
    const [stdout0, io] = await mount.executeCmd(cmdName, subPaths, subTexts, subFlags, {
      stdin,
      cwd,
      ...(ns === undefined ? {} : { ns }),
      ...(statPath !== null ? { statPath } : {}),
    })
    let stdout: ByteSource | null = stdout0
    if (mount !== primaryMount && io.exitCode === 127) {
      // A descendant that does not serve this command contributes
      // nothing to the aggregate walk instead of failing it (du across
      // a tree holding a view mount without a du op).
      continue
    }
    if (cmdName === 'find' && io.matchedRuns !== null) {
      if (mount === primaryMount) {
        // One run per operand, minus the rows a descendant mount
        // answers for.
        for (const run of io.matchedRuns) {
          findMatches.push(
            run.filter(
              (p) =>
                !descendantPrefixes.some(
                  (pre) => p.virtual === pre || p.virtual.startsWith(pre + '/'),
                ),
            ),
          )
        }
      } else {
        // A descendant walks under the first operand, so its rows join
        // that operand's run.
        const rows = io.matchedRuns.flat().filter((p) => p.virtual !== rstripSlash(mount.prefix))
        const first = findMatches[0]
        if (first === undefined) findMatches.push(rows)
        else first.push(...rows)
      }
      stdout = null
    } else if (mount === primaryMount && descendantPrefixes.length > 0 && stdout !== null) {
      stdout = await filterUnderPrefixes(stdout, descendantPrefixes, cmdName)
    }
    if (stdout !== null) {
      const data = await materialize(stdout)
      if (data.length > 0) {
        if (cmdName === 'find') findMatchesComplete = false
        allStdout.push(data)
      }
    }
    if (io.exitCode === 0) {
      successSeen = true
    } else if (finalExit === 0) {
      finalExit = io.exitCode
    }
    mergedIo = await mergedIo.merge(io)
  }

  let rows: PathSpec[] = []
  if (cmdName === 'find') {
    const synthetic = await synthesizeFindMountEntries(
      targetPath,
      descendants,
      texts,
      paths[0]?.rawPath ?? targetPath,
      statPath,
    )
    // The mount points a walk cannot see belong to the first operand's
    // run, the one that holds them.
    if (synthetic.length > 0) {
      const first = findMatches[0]
      if (first === undefined) findMatches.push(synthetic)
      else first.push(...synthetic)
    }
    rows = findMatches.flat()
    if (!findMatchesComplete && rows.length > 0) {
      allStdout.push(
        new TextEncoder().encode(rows.map((p) => p.rawPath || p.virtual).join('\n') + '\n'),
      )
    }
  }

  const finalIoExit = successSeen ? 0 : finalExit
  let combined: ByteSource | null = null
  if (duMerge && allStdout.length > 0) {
    combined = mergeDuBlocks(allStdout, targetPath, paths[0]?.rawPath ?? targetPath, {
      ...duOpts,
      mountRoots: await mountDirs(descendants, statPath),
    })
  } else if (cmdName === 'find' && rows.length > 0 && findMatchesComplete) {
    if (paths.length === 1) {
      rows = [...new Map(rows.map((p) => [p.virtual, p])).values()].sort((a, b) =>
        compareCodePoints(a.rawPath, b.rawPath),
      )
      findMatches = [rows]
    }
    combined = new TextEncoder().encode(rows.map((p) => p.rawPath || p.virtual).join('\n') + '\n')
  } else if (allStdout.length > 0) {
    const parts = allStdout.map((d) => {
      const s = new TextDecoder().decode(d).replace(/\n+$/, '')
      return s
    })
    // `ls -R` separates directory groups with a blank line, and a
    // per-mount block is one more group; every other format is a plain
    // line stream.
    const sep = cmdName === 'ls' ? '\n\n' : '\n'
    combined = new TextEncoder().encode(parts.filter((s) => s !== '').join(sep) + '\n')
  }

  if (cmdName === 'find') {
    // The structured rows ride out for the command boundary, which
    // applies find's actions once over every operand's matches.
    mergedIo.matchedRuns = findMatchesComplete ? findMatches : null
  }

  mergedIo.exitCode = finalIoExit
  mergedIo.producer = {
    command: cmdName,
    prefixes: mountsToRun.map((m) => m.prefix),
    declared: null,
  }
  const stderrBytes = await materialize(mergedIo.stderr)
  const exec = new ExecutionNode({
    command: cmdStr,
    stderr: stderrBytes,
    exitCode: finalIoExit,
  })
  return [combined, mergedIo, exec]
}

// One operand's native run, fanned out over the mounts nested in it.
//
// A line whose operands span mounts runs once per operand on the operand's
// owning mount, and that runner is single-mount by construction: it never
// descends into a mount nested *under* the operand. So `du /base /other`
// reported the parent backend's keys shadowed by a mount at `/base/inner`
// and none of that mount's own, while `du /base` on the same tree got both
// right. Wrapping the per-operand runner is what makes the two agree, and
// it is a pass-through for everything the traversal fan-out does not claim.
export function runWithFanout(
  runSingle: RunSingle,
  registry: MountRegistry,
  cwd: string,
  ns: NamespaceView | undefined,
  ensureOpen: ((resource: Resource) => Promise<void>) | undefined,
  statPath: StatPath | null = null,
): RunSingle {
  return async (cmdName, paths, texts, flagKwargs, opts) => {
    const stdin = opts?.stdin ?? null
    if (!shouldFanOut(cmdName, paths, flagKwargs, registry)) {
      return runSingle(cmdName, paths, texts, flagKwargs, opts ?? {})
    }
    let mount: MountEntry | null = null
    try {
      mount = await registry.resolveMount(cmdName, paths, cwd)
    } catch (err) {
      // The single-mount runner owns the wording for a command this mount
      // does not serve, so let it report rather than re-throwing.
      if (!(err instanceof MountCommandUnsupported)) throw err
    }
    if (mount === null) return runSingle(cmdName, paths, texts, flagKwargs, opts ?? {})
    const [stdout, io] = await fanOutTraversal(
      cmdName,
      paths,
      texts,
      flagKwargs,
      registry,
      mount,
      cwd,
      cmdName,
      stdin,
      ensureOpen,
      ns,
      statPath,
    )
    return [stdout, io]
  }
}
