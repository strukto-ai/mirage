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

type Result = [ByteSource | null, IOResult, ExecutionNode]

const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'tree', 'du'])

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
}

export function shouldFanOut(
  cmdName: string,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  registry: MountRegistry,
): boolean {
  if (paths.length === 0 || paths[0] === undefined) return false
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
// other line of the walk.
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
  const out: string[] = []
  for (const m of descendants) {
    const prefixNoSlash = rstripSlash(m.prefix)
    const depth = pathSegments(prefixNoSlash).length - parentDepth
    if (maxDepth !== null && depth > maxDepth) continue
    const segs = prefixNoSlash.split('/').filter((s) => s !== '')
    const base = segs[segs.length - 1] ?? prefixNoSlash
    if (!keep({ key: prefixNoSlash, name: base, kind: 'd', depth }, tree, minDepth)) continue
    out.push(respellOne(prefixNoSlash, targetPath, raw))
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
): Promise<Result> {
  const targetPath = paths[0]?.virtual ?? cwd
  const descendants = registry.descendantMounts(targetPath)
  const descendantPrefixes = descendants.map((m) => rstripSlash(m.prefix))

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
    const [stdout0, io] = await mount.executeCmd(cmdName, subPaths, subTexts, subFlags, {
      stdin,
      cwd,
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
  if (allStdout.length > 0) {
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
