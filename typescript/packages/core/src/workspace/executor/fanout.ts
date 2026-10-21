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

import { DISPATCH_BUILDERS } from '../../commands/builtin/generic/crossmount/constants.ts'
import { runDu } from '../../commands/builtin/generic/crossmount/du.ts'
import { runFind } from '../../commands/builtin/generic/crossmount/find.ts'
import { handleCrossMount } from '../../commands/builtin/generic/crossmount/route.ts'
import type { RunSingle, DispatchFn } from '../../commands/builtin/generic/crossmount/types.ts'
import { runDispatch } from '../../commands/builtin/generic_bind/dispatch.ts'
import { UsageError } from '../../commands/errors.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { readFailExitCode } from '../../commands/spec/usage.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { FollowOperands, SessionView } from '../../view/types.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { stripSlash } from '../../utils/slash.ts'
import { formatFsError } from '../../errors/render.ts'
import type { MountEntry } from '../mount/mount.ts'
import { MountCommandUnsupported, type MountRegistry } from '../mount/registry.ts'
import { ExecutionNode } from '../types.ts'
import { type Files, readerOf } from '../files.ts'
import { walksMounts } from '../lookup/index.ts'

const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'du'])

// The walks the fan-out composes over nested mounts: find and du from each
// mount's rows, ls and the searches from each mount's own part. tree walks
// them through the dispatcher's listings.
const COMPOSED: ReadonlySet<string> = new Set([...TRAVERSAL_CMDS, 'ls', 'grep', 'rg'])

/**
 * One mount's part of a find or du, on the command that mount serves. A mount
 * that registers no find or du of its own still answers its part through the
 * generic walk over the dispatcher, since both read only the metadata every
 * mount serves.
 */
function ownPart(
  runSingle: RunSingle,
  registry: MountRegistry,
  dispatch: DispatchFn,
  cwd: string,
  vfs: Files | undefined,
  follow: FollowOperands | undefined,
): RunSingle {
  return async (cmdName, paths, texts, bag, opts) => {
    try {
      await registry.resolveMount(cmdName, paths, cwd)
    } catch (err) {
      if (!(err instanceof MountCommandUnsupported)) throw err
      const builder = DISPATCH_BUILDERS.get(cmdName)
      if (builder === undefined) throw new Error(`No dispatch builder for ${cmdName}`)
      return runDispatch(
        builder,
        paths,
        texts,
        bag,
        dispatch,
        cwd,
        vfs,
        opts?.stdin ?? null,
        opts?.signal,
        [],
        follow,
        registry.diff,
      )
    }
    return runSingle(cmdName, paths, texts, bag, opts ?? {})
  }
}

export function shouldFanOut(
  cmdName: string,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  registry: MountRegistry,
): boolean {
  // Use the raw mount table: hidden descendants still shadow backend keys.
  // A refused operand names nothing; every valid operand may own a subtree.
  if (!paths.some((p) => p.walkError === null && registry.descendantMounts(p.virtual).length > 0))
    return false
  return COMPOSED.has(cmdName) && walksMounts(cmdName, flagKwargs)
}

/**
 * Compose a traversal over the mounts inside its operands. Each mount's own
 * command answers for its part: find and du from every mount's structured
 * rows and measurements, a search from its owned scopes. No output is
 * inspected to recover paths or repair depth and totals.
 */
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
  vfs?: Files,
  sessionView?: SessionView,
  signal?: AbortSignal,
  dispatch?: DispatchFn,
  native?: RunSingle,
  // The line's operand resolution, which a walk through the dispatcher's
  // globs take.
  follow?: FollowOperands,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  signal?.throwIfAborted()
  if (dispatch === undefined || native === undefined)
    throw new Error('traversal requires dispatcher and native execution')
  let stdout: ByteSource | null
  let io: IOResult
  const part = ownPart(native, registry, dispatch, cwd, vfs, follow)
  try {
    if (cmdName === 'find') {
      ;[stdout, io] = await runFind(
        paths,
        texts,
        flagKwargs,
        dispatch,
        part,
        cwd,
        vfs,
        stdin,
        signal,
        follow,
      )
    } else if (cmdName === 'du') {
      ;[stdout, io] = await runDu(
        paths,
        texts,
        flagKwargs,
        dispatch,
        part,
        cwd,
        vfs,
        stdin,
        signal,
        true,
        follow,
      )
    } else {
      ;[stdout, io] = await handleCrossMount(
        cmdName,
        [...paths],
        [...texts],
        flagKwargs,
        dispatch,
        native,
        stdin,
        undefined,
        vfs,
        sessionView,
        cwd,
        [],
        null,
        undefined,
        follow,
        registry.diff,
        signal,
      )
    }
  } catch (err) {
    if (err instanceof CommandTimeoutError || (err instanceof Error && err.name === 'AbortError'))
      throw err
    stdout = null
    if (err instanceof UsageError) {
      io = new IOResult({
        exitCode: err.exitCode,
        stderr: encodeText(`${err.message}\n`),
      })
    } else {
      // A backend failure anywhere in the walk (a 5xx from a nested mount)
      // is this command's result, in its voice, as the single-mount entry point
      // reports it; the rest of the line still runs.
      io = new IOResult({
        exitCode: readFailExitCode(cmdName, err),
        stderr: formatFsError(cmdName, err, paths),
      })
    }
  }
  // Only the mounts the walk can reach bound its output: a hidden one never
  // contributes a row, so its stricter limit must not apply.
  const prefixes = new Set([primaryMount.prefix])
  const reader = vfs === undefined ? null : readerOf(vfs)
  for (const path of paths) {
    if (path.walkError !== null) continue
    for (const mount of registry.descendantMounts(path.virtual))
      if (reader === null || reader.visible('/' + stripSlash(mount.prefix)))
        prefixes.add(mount.prefix)
  }
  io.producer = {
    command: cmdName,
    prefixes: [...prefixes].sort(compareCodePoints),
    declared: null,
  }
  return [
    stdout,
    io,
    new ExecutionNode({
      command: cmdStr,
      exitCode: io.exitCode,
      stderr: await io.materializeStderr(),
    }),
  ]
}

export function runWithFanout(
  runSingle: RunSingle,
  registry: MountRegistry,
  cwd: string,
  vfs: Files | undefined,
  sessionView?: SessionView,
  signal?: AbortSignal,
  dispatch?: DispatchFn,
  // The line's operand resolution, which a walk through the dispatcher's
  // globs take.
  follow?: FollowOperands,
): RunSingle {
  return async (cmdName, paths, texts, flagKwargs, opts) => {
    const stdin = opts?.stdin ?? null
    if (!shouldFanOut(cmdName, paths, flagKwargs, registry)) {
      const run =
        TRAVERSAL_CMDS.has(cmdName) && dispatch !== undefined
          ? ownPart(runSingle, registry, dispatch, cwd, vfs, follow)
          : runSingle
      return run(cmdName, paths, texts, flagKwargs, opts ?? {})
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
      vfs,
      sessionView,
      signal,
      dispatch,
      runSingle,
      follow,
    )
    return [stdout, io]
  }
}
