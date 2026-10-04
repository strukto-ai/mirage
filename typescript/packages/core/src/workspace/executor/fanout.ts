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
import { handleCrossMount } from '../../commands/builtin/generic/crossmount/route.ts'
import { walksMounts } from '../../commands/builtin/generic/crossmount/search.ts'
import type { RunSingle, DispatchFn } from '../../commands/builtin/generic/crossmount/types.ts'
import { runDispatch } from '../../commands/builtin/generic_bind/dispatch.ts'
import { UsageError } from '../../commands/errors.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { readFailExitCode } from '../../commands/spec/usage.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { NamespaceView, SessionView } from '../../ops/types.ts'
import type { PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { formatFsError, isFsError } from '../../utils/errors.ts'
import type { MountEntry } from '../mount/mount.ts'
import { MountCommandUnsupported, type MountRegistry } from '../mount/registry.ts'
import { ExecutionNode } from '../types.ts'

const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'du'])

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
  if (cmdName === 'du') return flagKwargs.one_file_system !== true
  if (TRAVERSAL_CMDS.has(cmdName)) return true
  if (cmdName === 'ls') {
    return flagKwargs.recursive === true
  }
  return walksMounts(cmdName, flagKwargs)
}

/** Native content search or one metadata traversal over the mounted tree. */
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
  ns?: NamespaceView,
  sessionView?: SessionView,
  signal?: AbortSignal,
  dispatch?: DispatchFn,
  native?: RunSingle,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  signal?.throwIfAborted()
  if (dispatch === undefined || native === undefined)
    throw new Error('traversal requires dispatcher and native execution')
  let stdout: ByteSource | null
  let io: IOResult
  try {
    if (cmdName === 'find' || cmdName === 'du') {
      const builder = DISPATCH_BUILDERS.get(cmdName)
      if (builder === undefined) throw new Error(`No traversal builder for ${cmdName}`)
      ;[stdout, io] = await runDispatch(
        builder,
        paths,
        texts,
        flagKwargs,
        dispatch,
        cwd,
        ns,
        stdin,
        signal,
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
        ns,
        sessionView,
        cwd,
      )
    }
  } catch (err) {
    if (err instanceof UsageError) {
      stdout = null
      io = new IOResult({
        exitCode: err.exitCode,
        stderr: new TextEncoder().encode(`${err.message}\n`),
      })
    } else if (isFsError(err)) {
      stdout = null
      io = new IOResult({
        exitCode: readFailExitCode(cmdName, err),
        stderr: formatFsError(cmdName, err, paths),
      })
    } else throw err
  }
  const prefixes = new Set([primaryMount.prefix])
  for (const path of paths)
    for (const mount of registry.descendantMounts(path.virtual)) prefixes.add(mount.prefix)
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
      stderr: await materialize(io.stderr),
    }),
  ]
}

export function runWithFanout(
  runSingle: RunSingle,
  registry: MountRegistry,
  cwd: string,
  ns: NamespaceView | undefined,
  sessionView?: SessionView,
  signal?: AbortSignal,
  dispatch?: DispatchFn,
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
      ns,
      sessionView,
      signal,
      dispatch,
      runSingle,
    )
    return [stdout, io]
  }
}
