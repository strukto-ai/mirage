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

import { mountAllowed } from '../../context/session_context.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { PathSpec } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { ExecutionNode } from '../types.ts'
import { applyFindActions } from './find_action_dispatch.ts'
import { respellOne } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { keep } from '../../commands/builtin/findEval.ts'
import {
  FindParseError,
  parseFindExpression,
  type FindExpr,
} from '../../commands/builtin/findParse.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import type { ChildMounts, StatPath } from '../../ops/types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'tree', 'du'])

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
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
  return registry.descendantMounts(path).filter((m) => mountAllowed(m.prefix))
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
function synthesizeFindMountEntries(
  targetPath: string,
  descendants: readonly MountEntry[],
  texts: readonly string[],
  raw: string,
): string {
  let expr: FindExpr
  try {
    expr = parseFindExpression([...texts])
  } catch (err) {
    if (err instanceof FindParseError) return ''
    throw err
  }
  const tree = expr.tree
  const maxDepth = expr.maxDepth
  const minDepth = expr.minDepth ?? 0
  const parentDepth = pathSegments(targetPath).length
  const parentBase = rstripSlash(targetPath)
  const seen = new Set<string>()
  const out: string[] = []
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
      out.push(respellOne(candidate, targetPath, raw))
    }
  }
  return out.join('\n')
}

async function filterUnderPrefixes(
  stdout: ByteSource,
  descendantPrefixes: readonly string[],
): Promise<Uint8Array> {
  const data = await materialize(stdout)
  const text = new TextDecoder().decode(data)
  const outLines: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let path = line
    for (const sep of ['\t', ':']) {
      const idx = path.indexOf(sep)
      if (idx >= 0) {
        path = path.slice(0, idx)
        break
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

async function dropMountRootLine(stdout: ByteSource, mountRoot: string): Promise<Uint8Array> {
  const data = await materialize(stdout)
  const text = new TextDecoder().decode(data)
  const outLines = text.split('\n').filter((line) => line !== '' && line !== mountRoot)
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
  childMounts: ChildMounts | null = null,
  statPath: StatPath | null = null,
): Promise<Result> {
  const targetPath = paths[0]?.virtual ?? cwd
  const descendants = allowedDescendants(registry, targetPath)
  // The shadow filter keeps the raw list on purpose: a mount the
  // session cannot see still shadows the primary backend's keys under
  // its prefix, the walk just never descends into it.
  const descendantPrefixes = registry.descendantMounts(targetPath).map((m) => rstripSlash(m.prefix))

  const allStdout: Uint8Array[] = []
  let mergedIo = new IOResult()
  let finalExit = 0
  let successSeen = false

  const mountsToRun: MountEntry[] = [primaryMount, ...descendants]
  for (const mount of mountsToRun) {
    let subPaths: PathSpec[]
    let subFlags: Record<string, FlagValue>
    let subTexts: string[]
    if (mount === primaryMount) {
      subPaths = [...paths]
      subFlags = { ...flagKwargs }
      subTexts = [...texts]
    } else {
      const adjusted = adjustDepthFlags(flagKwargs, targetPath, mount.prefix)
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
          rawPath: respellOne(mountRoot, targetPath, paths[0]?.rawPath ?? targetPath),
        }),
      ]
    }
    // Errors propagate, mirroring python: a mount that cannot open or
    // whose command raises is a real failure, never a silently missing
    // slice of the aggregate. Unserved commands return 127 (below).
    if (ensureOpen !== undefined) {
      await ensureOpen(mount.resource)
    }
    // Two facts threaded into the per-mount runs: the child-mount names
    // and the dispatcher-backed start-point stat. A start point only
    // the namespace serves (a nested mount's ancestor) has no backend
    // listing, so without them the primary run reports the operand
    // missing. Links and stat overlays are still dropped here, a known
    // seam of the fan-out.
    const [stdout0, io] = await mount.executeCmd(cmdName, subPaths, subTexts, subFlags, {
      stdin,
      cwd,
      ...(childMounts !== null ? { childMounts } : {}),
      ...(statPath !== null ? { statPath } : {}),
    })
    let stdout: ByteSource | null = stdout0
    if (mount !== primaryMount && io.exitCode === 127) {
      // A descendant that does not serve this command contributes
      // nothing to the aggregate walk instead of failing it (du across
      // a tree holding a view mount without a du op).
      continue
    }
    if (mount === primaryMount && descendantPrefixes.length > 0 && stdout !== null) {
      stdout = await filterUnderPrefixes(stdout, descendantPrefixes)
    } else if (mount !== primaryMount && cmdName === 'find' && stdout !== null) {
      // The child's own root line arrives respelled with the operand's
      // typed base, so drop that spelling, not the absolute prefix.
      stdout = await dropMountRootLine(stdout, subPaths[0]?.rawPath ?? '')
    }
    if (stdout !== null) {
      const data = await materialize(stdout)
      if (data.length > 0) allStdout.push(data)
    }
    if (io.exitCode === 0) {
      successSeen = true
    } else if (finalExit === 0) {
      finalExit = io.exitCode
    }
    mergedIo = await mergedIo.merge(io)
  }

  if (cmdName === 'find') {
    const synthetic = synthesizeFindMountEntries(
      targetPath,
      descendants,
      texts,
      paths[0]?.rawPath ?? targetPath,
    )
    if (synthetic !== '') allStdout.push(new TextEncoder().encode(synthetic))
  }

  let finalIoExit = successSeen ? 0 : finalExit
  let combined: ByteSource | null = null
  if (allStdout.length > 0 && cmdName === 'find' && paths.length === 1) {
    // GNU lists a directory before its contents, and the per-mount
    // blocks land here as separate chunks, so plain concatenation
    // printed a mount root after its own descendants. Every find line
    // is a bare path at this stage (actions render later), and a path
    // always sorts before its extensions, so one path sort restores
    // GNU's invariant and matches the per-mount emit order. A
    // single-operand walk never visits a path twice, so the set
    // collapses a synthesized ancestor row against a primary backend
    // that happens to hold a real directory at the same path. Multiple
    // operands keep the concatenation: GNU walks operands in
    // command-line order, which a global sort would not honor.
    const lines = [
      ...new Set(
        allStdout
          .flatMap((d) => new TextDecoder().decode(d).split('\n'))
          .filter((line) => line !== ''),
      ),
    ].sort()
    combined = new TextEncoder().encode(lines.join('\n') + '\n')
  } else if (allStdout.length > 0) {
    const parts = allStdout.map((d) => {
      const s = new TextDecoder().decode(d).replace(/\n+$/, '')
      return s
    })
    combined = new TextEncoder().encode(parts.filter((s) => s !== '').join('\n') + '\n')
  }

  if (cmdName === 'find') {
    const [newCombined, actionErr] = await applyFindActions(combined, flagKwargs, registry, cwd)
    combined = newCombined
    if (actionErr.length > 0) {
      const existing = await materialize(mergedIo.stderr)
      const merged = new Uint8Array(existing.length + actionErr.length)
      merged.set(existing, 0)
      merged.set(actionErr, existing.length)
      mergedIo.stderr = merged
      if (finalIoExit === 0) finalIoExit = 1
    }
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
