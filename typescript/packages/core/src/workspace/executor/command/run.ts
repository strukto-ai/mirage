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

import type { EvaluationContext } from '../../evaluation.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { ReaddirPath, StatPath } from '../../../view/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { envSnapshot, sessionView } from '../../session/state.ts'
import { pathReaddir, pathStat } from '../../mount/namespace/probe.ts'
import { namespaceViewOf } from '../../mount/namespace/view.ts'
import { MountCommandUnsupported, type MountRegistry } from '../../mount/registry.ts'
import { ownLimit } from '../../../policy/builtin/output_cap.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { WorkspaceRuntime } from '../../../runtime/workspace.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import type { SessionState } from '../../session/session.ts'
import type { DispatchFn, ShellFn } from '../../../runtime/types.ts'
import type { ExecuteFn } from '../../expand/node.ts'
import { UsageError } from '../../../commands/errors.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { readFailExitCode } from '../../../commands/spec/usage.ts'
import { formatFsError } from '../../../errors/render.ts'

import { makeAbortError, mergeSignals } from '../../../utils/abort.ts'
import type { Flags } from './types.ts'
import { parseFlags } from './flags.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
import { encodeText } from '../../../shell/bytes.ts'

export interface RunOnMountCtx {
  registry: MountRegistry
  context: EvaluationContext
  dispatch: DispatchFn
  namespace?: Namespace
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: RouteDecision<Runtime>
  signal?: AbortSignal
  executeFn?: ExecuteFn
}

/**
 * The entry point a command handler runs a nested line through (`opts.shell`):
 * the line runs in the calling command's own session, under its signal,
 * reading the input it is handed.
 */
function nestedShell(
  executeFn: ExecuteFn,
  session: SessionState,
  signal: AbortSignal | undefined,
): ShellFn {
  return (line: string, stdin: ByteSource | null) =>
    executeFn(line, {
      sessionId: session.sessionId,
      session,
      stdin,
      ...(signal !== undefined ? { signal } : {}),
    })
}

/**
 * find's start points: the path operands typed before its expression.
 * The expression tail is the parser's, so a word inside it (an `-exec`
 * command word, a `-newer` reference) is never a start point even when
 * the rest slot's PATH kind would have read it as one. Only the head is
 * parsed against the spec, so what it yields as path operands is exactly
 * the start points.
 */
export function findStartPoints(
  argv: readonly (string | PathSpec)[],
  exprTokens: readonly string[],
  spec: CommandSpec | null,
  cwd: string,
): PathSpec[] {
  const head = argv.slice(0, argv.length - exprTokens.length)
  return parseFlags(head, spec, 'find', cwd).paths
}

interface RunOnMountOpts {
  signal?: AbortSignal
  stdin?: ByteSource | null
  resolveHint?: PathSpec | null
  mount?: MountEntry | null
  // The words after the command name, as the line spelled them; absent for
  // a run split out of a line.
  argv?: readonly string[]
}

/** The 126 result for a command no runtime accepted. */
export function admissionDenial(cmdName: string): IOResult {
  const msg = `${cmdName}: no runtime accepted this line\n`
  return new IOResult({ exitCode: 126, stderr: encodeText(msg) })
}

/**
 * Resolve a command against the line's routing decision. With no
 * decision, the static bindings apply. With one, the command's runtime
 * is looked up in the decision: its binding, or the decision's
 * fallback when no entry captures it. A resolved WorkspaceRuntime means the
 * executor serves the command itself (the workspace runtime has no
 * interpreter entry point); null means no runtime accepted it: exit 126,
 * "no runtime accepted this line", like a shell refusing to exec.
 */
function lineRuntimeFor(
  cmdName: string,
  runtimeBindings: Record<string, Runtime> | undefined,
  fallback: Runtime | null,
  routingDecision: RouteDecision<Runtime> | undefined,
): [Runtime | undefined, IOResult | null] {
  if (routingDecision === undefined) {
    const restricted = fallback instanceof WorkspaceRuntime && fallback.restricted
    const runtime = runtimeBindings?.[cmdName]
    if (runtime !== undefined && runtime === fallback) return [undefined, null]
    if (runtime === undefined && restricted) return [undefined, admissionDenial(cmdName)]
    return [runtime, null]
  }
  const runtime = Object.hasOwn(routingDecision.bindings, cmdName)
    ? routingDecision.bindings[cmdName]
    : routingDecision.fallback
  if (runtime === null || runtime === undefined) return [undefined, admissionDenial(cmdName)]
  if (runtime instanceof WorkspaceRuntime) return [undefined, null]
  return [runtime, null]
}

// `multiple: true` on find value-flags makes parseToKwargs emit arrays;
// bespoke backend wrappers read these as scalars. Migrated backends read the
// expression from `texts` and ignore flagKwargs.
function scalarFindFlags(flagKwargs: Flags): Flags {
  const out: Flags = { ...flagKwargs }
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value)) {
      const last = value.at(-1)
      if (last !== undefined) out[key] = last
    }
  }
  return out
}

/**
 * Drop every mount's cached listings and bodies after an account CLI write.
 *
 * An account CLI mutates its service by id, so no vfs path can be derived from
 * the call and per-path invalidation has nothing to aim at: after
 * `gws sheets spreadsheets create` the new file has no cache entry to expire,
 * which is exactly the case that matters. Which mounts that service backs is
 * not the CLI's business either (a CLI and a VFS are separate tiers, and
 * a user's own CLI knows nothing about a user's own VFS), so the executor
 * says the one thing it knows: a write happened, and every mount may be stale.
 * A write verb is rare next to reads, and the cost is one cold listing on a
 * mount's next read, never a wrong answer.
 *
 * Both caches go, because the two hide different writes. A stale listing hides
 * a create or a delete; a stale body hides an edit, and these mounts cache
 * reads, so a `cat` after `gws docs documents batchUpdate` would otherwise keep
 * serving the pre-edit content without ever reaching Google.
 */
export async function dropMountCaches(registry: MountRegistry): Promise<void> {
  for (const mount of registry.allMounts()) {
    // Invalidate rather than clear: a cleared index reads exactly like one
    // that was never filled, so a backend whose index *is* its listing
    // (github seeds the whole tree once) cannot tell the drop from an empty
    // repository. Expiring keeps that distinction and the next read refetches.
    await mount.index.invalidate()
    await mount.cacheManager?.dropPrefix()
  }
}

// Run one already-parsed command on the mount that owns its paths. The shared
// single-mount execution tail: mount resolution, session-mode checks, runCommand,
// filesystem-error formatting, ls/find post-processing, and read/write key
// prefixing. handleCommand uses it for the normal path, and passes it (bound)
// to the cross-mount runners so each operand executes natively on its owning
// mount. `resolveHint` names the path whose mount runs the command, ahead of
// the first of `paths`: a stream command in stdin mode has none, and awk over
// operands on several mounts runs where its first file lives. A pre-resolved
// `mount` skips resolution and session-mode checks, which the caller already
// performed.
export async function runOnMount(
  ctx: RunOnMountCtx,
  cmdName: string,
  paths: PathSpec[],
  texts: string[],
  flagKwargs: Flags,
  opts: RunOnMountOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { registry, context, dispatch, namespace, runtimeBindings, routingDecision } = ctx
  const session = context.session
  const hint = opts.resolveHint ?? null
  let mount = opts.mount ?? null
  if (mount === null) {
    const resolvePaths = hint !== null ? [hint] : paths
    try {
      mount = await registry.resolveMount(cmdName, resolvePaths, session.cwd)
    } catch (err) {
      if (err instanceof MountCommandUnsupported) {
        const errBytes = encodeText(`${err.message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
      }
      throw err
    }
    if (mount === null) {
      const errBytes = encodeText(`${cmdName}: command not found`)
      return [null, new IOResult({ exitCode: 127, stderr: errBytes })]
    }
  }

  let flags = flagKwargs
  if (cmdName === 'find') flags = scalarFindFlags(flags)

  // The profile, serving mount and workspace entries, in precedence order;
  // the mount folds in the command's declared default and the built-in.
  const limitOverride =
    ownLimit(session.commandLimits, cmdName) ??
    mount.commandLimits.get(cmdName) ??
    ownLimit(registry.commandLimits, cmdName)

  // The name plane's facts, bundled as one view: the attr overlay so
  // ls -l and stat -c agree (cp/mv -u freshness and find -mtime compare
  // the same merged mtimes), the symlink table no backend readdir or
  // stat can see, the mount boundaries, and the child names the
  // namespace owes a directory. A command that does not read `ns` off
  // its context ignores it, so there is no list of aware commands to
  // keep in step.
  const ns = namespaceViewOf(registry, namespace ?? null, dispatch, session)
  const statOverlay = ns.statOverlay ?? null
  // A traversal command's start point is statted through the dispatcher so
  // a start point under another mount answers (`find -L` follows a link
  // across mounts before the command ever runs).
  const statPath: StatPath = (path) => pathStat(dispatch, path, statOverlay)
  // The same entry point for a listing: a walker whose output is one document
  // (tree) reads the subtree under a nested mount through here, because
  // that subtree lives in a VFS its own accessor cannot open.
  const readdirPath: ReaddirPath = (path: string) => pathReaddir(dispatch, path)

  const [lineRuntime, denial] = lineRuntimeFor(
    cmdName,
    runtimeBindings,
    registry.workspaceRuntime,
    routingDecision,
  )
  if (denial !== null) return [null, denial]

  const signal = mergeSignals(mergeSignals(ctx.signal, ctx.context.frame.abortSignal), opts.signal)
  // A leaf that resumes here after the caller aborted must not reach a
  // mount handler: eager write handlers do not read the signal, and a
  // cancelled `rm` must not run.
  if (signal?.aborted === true) throw makeAbortError(signal)
  try {
    return await mount.runCommand(cmdName, paths, texts, flags, {
      stdin: opts.stdin ?? null,
      cwd: session.cwd,
      dispatch,
      sessionId: session.sessionId,
      env: envSnapshot(session),
      sessionView: sessionView(session, registry.policies, context.frame.diagnostics),
      ...(registry.processView === undefined ? {} : { processes: registry.processView(session) }),
      execAllowed: registry.isExecAllowed(),
      execPathAllowed: registry.execAllowedAt,
      ...(lineRuntime !== undefined ? { runtime: lineRuntime } : {}),
      ns,
      statPath,
      readdirPath,
      ...(signal !== undefined ? { signal } : {}),
      ...(ctx.executeFn !== undefined
        ? { shell: nestedShell(ctx.executeFn, session, signal) }
        : {}),
      limitOverride,
      ...(opts.argv !== undefined ? { argv: opts.argv } : {}),
    })
  } catch (err) {
    // Command-owned usage errors (extra operands, missing patterns) become
    // this command's IOResult so the rest of the line keeps running, like a
    // real shell (#452).
    if (err instanceof UsageError) {
      return [
        null,
        new IOResult({
          exitCode: err.exitCode,
          stderr: encodeText(`${err.message}\n`),
        }),
      ]
    }
    // A limit timeout is not a filesystem failure: let it reach the
    // workspace-level handler that answers with exit 124.
    if (err instanceof CommandTimeoutError || (err instanceof Error && err.name === 'AbortError'))
      throw err
    return [
      null,
      new IOResult({
        exitCode: readFailExitCode(cmdName, err),
        stderr: formatFsError(cmdName, err, paths),
      }),
    ]
  }
}
