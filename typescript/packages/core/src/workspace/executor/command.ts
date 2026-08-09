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

import { SPECS } from '../../commands/spec/index.ts'
import { concatBytes } from '../../core/jq/format.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { assertMountAllowed, MountNotAllowedError } from '../../context/session_context.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { PathSpec } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import { MountCommandUnsupported, type MountRegistry } from '../mount/registry.ts'
import { makeStorageKey } from '../mount/storage.ts'
import { Consumer, JOB_BUILTINS, route } from '../route/index.ts'
import { type Runtime } from '../../runtime/base.ts'
import type { PolicyDecision } from '../../runtime/policy/index.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { strategyFor } from '../../commands/builtin/generic/crossmount/detect.ts'
import type { Cmd } from '../../commands/builtin/generic/crossmount/types.ts'
import { Strategy } from '../../commands/builtin/generic/crossmount/types.ts'
import { resolveGlobs } from '../expand/globs.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCrossMount, isCrossMount } from './cross_mount.ts'
import type { RunSingle } from '../../commands/builtin/generic/crossmount/index.ts'
import { fanOutTraversal, shouldFanOut } from './fanout.ts'
import {
  FindParseError,
  findExprTail,
  parseFindExpression,
} from '../../commands/builtin/findParse.ts'
import { maybeWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { resolveProducer, resolveLimit } from '../../policy/index.ts'
import type { ExecuteNodeFn, JobHandlerResult } from './jobs.ts'
import { handleFg, handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'
import { versionRequest } from '../../commands/config.ts'

import { handleCli } from './command/cli.ts'
import { pathStat } from './builtins/links.ts'
import { dropServiceCaches, mountRootOf } from './command/run.ts'
import { optionError, parseFlags } from './command/flags.ts'
import { executeShellFunction } from './command/functions.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  mergeScopes,
  pathFlagScopes,
} from './command/routing.ts'
import { runOnMount, type RunOnMountCtx } from './command/run.ts'
import type { Result } from './command/types.ts'

export { ReturnSignal } from './control.ts'

// One handler per JOB_BUILTINS member; route already narrowed the name.
const JOB_HANDLERS: Record<
  string,
  (jobTable: JobTable, textParts: string[]) => JobHandlerResult | Promise<JobHandlerResult>
> = {
  wait: handleWait,
  fg: handleFg,
  kill: handleKill,
  jobs: handleJobs,
  ps: handlePs,
}

export async function handleCommand(
  executeNode: ExecuteNodeFn,
  dispatch: DispatchFn,
  registry: MountRegistry,
  parts: readonly (string | PathSpec)[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  namespace?: Namespace,
  routingDecision?: PolicyDecision,
): Promise<Result> {
  if (parts.length === 0) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  const head = parts[0]
  if (head === undefined) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  const cmdName = typeof head === 'string' ? head : head.virtual
  const cmdStr = parts.map((p) => (typeof p === 'string' ? p : p.virtual)).join(' ')

  if (JOB_BUILTINS.has(cmdName) && jobTable !== null) {
    const textParts = parts.map((p) => (typeof p === 'string' ? p : p.virtual))
    const handler = JOB_HANDLERS[cmdName]
    if (handler !== undefined) return handler(jobTable, textParts)
  }

  const funcBody = session.functions[cmdName]
  if (funcBody !== undefined && Array.isArray(funcBody)) {
    return executeShellFunction(
      executeNode,
      cmdName,
      funcBody as unknown[],
      parts.slice(1),
      session,
      stdin,
      callStack,
    )
  }

  // Installed CLIs: dispatch by name, never by operand path. Sits
  // below functions (a user can wrap an installed CLI, bash-style)
  // and above every mount branch (a CLI consults no mount).
  // A CLI that works on files rather than an API (`git`) reaches the mount
  // through the facts below; the rest never read them.
  const cliInstall = registry.clis.get(cmdName)
  if (cliInstall !== null) {
    return handleCli(
      cliInstall,
      parts,
      session,
      stdin,
      {
        entries: registry.runtimeEntries,
        dispatch,
        statPath: (path: string) => pathStat(dispatch, path, null),
        mountRoot: (path: string) => mountRootOf(registry, path),
      },
      () => dropServiceCaches(registry, cliInstall.spec.serves),
    )
  }

  if (cmdName in CWD_DEFAULT_RAW) {
    const operand = defaultCwdOperand(parts, cmdName, registry, session.cwd, stdin)
    if (operand !== null) {
      // Where GNU's implied `.` sits: after the pattern for grep/rg
      // (the first positional is the pattern), right after the command
      // name for find/tree/du/ls (find's expression tokens must stay
      // behind the path).
      parts =
        cmdName === 'grep' || cmdName === 'rg'
          ? [...parts, operand]
          : [head, operand, ...parts.slice(1)]
    }
  }

  const pathScopes: PathSpec[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (p instanceof PathSpec) pathScopes.push(p)
  }
  const rawArgv = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.virtual))

  // Unknown name: nobody registers it; fail like bash before any
  // backend work. The admission policies (fired upstream at the
  // dispatch chokepoint) stay ahead of this so
  // protective refusals keep their specific messages.
  if (route(cmdName, session, registry) === Consumer.UNKNOWN) {
    const errBytes = new TextEncoder().encode(`${cmdName}: command not found\n`)
    return [
      null,
      new IOResult({ exitCode: 127, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, exitCode: 127, stderr: errBytes }),
    ]
  }

  // --version answers from the package, never from a backend, so it is
  // served before mount permission checks and cross-mount routing:
  // otherwise `rm --version /ro/x` hits the read-only refusal and
  // `cat --version /ram/a /disk/b` parses against the shared spec, which
  // carries no injected --version, and fails as an unknown option.
  const cmdMount = registry.mountForCommand(cmdName)
  const versionOut = versionRequest(cmdName, cmdMount?.specFor(cmdName) ?? null, rawArgv)
  if (versionOut !== null) {
    return [versionOut, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }

  // Path-valued flags (e.g. shuf --output=/dst/out) own a mount just like
  // positional operands, so they join routing and mount validation instead of
  // being dropped whenever a positional path is also present.
  const routingScopes = mergeScopes(pathScopes, pathFlagScopes(cmdName, rawArgv, session.cwd))

  let findExprTokens: string[] | null = null
  if (cmdName === 'find') {
    findExprTokens = findExprTail(rawArgv)
    try {
      parseFindExpression(findExprTokens)
    } catch (err) {
      if (err instanceof FindParseError) {
        const errBytes = new TextEncoder().encode(`${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
        ]
      }
      throw err
    }
  }

  // Path-valued flags count: `cp -t /other/mount/dir src` spans mounts
  // exactly like a positional destination would.
  if (isCrossMount(cmdName, routingScopes, registry)) {
    // Parse against the shared spec so flags and text operands do not
    // depend on the source mount: raw argv would hand flag tokens ("-c")
    // to the generic as the search pattern. The bound single-mount runner
    // lets the strategy runners execute each operand natively on its
    // owning mount.
    const csParsed = parseFlags(parts.slice(1), SPECS[cmdName] ?? null, cmdName, session.cwd)
    const csFlags = csParsed[2]
    const csTexts = findExprTokens ?? csParsed[1]
    const csRefusal = optionError(
      cmdName,
      csParsed[4],
      csParsed[5],
      csParsed[6],
      csParsed[7],
      csParsed[8],
      csParsed[9],
      csParsed[10],
      csParsed[11],
      csParsed[12],
    )
    if (csRefusal !== null) {
      const [msg, code] = csRefusal
      return [
        null,
        new IOResult({ exitCode: code, stderr: msg }),
        new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
      ]
    }
    let csScopes = pathScopes
    if (strategyFor(cmdName as Cmd, csFlags) === Strategy.RELAY) {
      // STREAM and FANOUT run each operand natively on its mount, which
      // expands the operand's glob. RELAY bypasses the mount command
      // wrappers entirely, so its glob operands must expand here; an
      // unmatched glob stays the literal word, like bash.
      const expanded = await resolveGlobs(pathScopes, registry)
      csScopes = expanded.filter((p): p is PathSpec => typeof p !== 'string')
    }
    const runCtx: RunOnMountCtx = {
      registry,
      session,
      dispatch,
      ...(namespace !== undefined ? { namespace } : {}),
      ...(ensureOpen !== undefined ? { ensureOpen } : {}),
      ...(runtimeBindings !== undefined ? { runtimeBindings } : {}),
      ...(routingDecision !== undefined ? { routingDecision } : {}),
    }
    const runSingle: RunSingle = (name, ps, ts, fk, opts) =>
      runOnMount(runCtx, name, ps, ts, fk, opts ?? {})
    const [csStdout, csIo, csExec] = await handleCrossMount(
      cmdName,
      csScopes,
      csTexts,
      csFlags,
      dispatch,
      runSingle,
      stdin,
      cmdStr,
      makeStorageKey(registry),
    )
    if (csParsed[3].length > 0) {
      const csWarn = new TextEncoder().encode(csParsed[3].map((w) => `${cmdName}: ${w}\n`).join(''))
      const csExisting = await materialize(csIo.stderr)
      csIo.stderr = concatBytes([csWarn, csExisting])
      csExec.stderr = concatBytes([csWarn, csExec.stderr])
    }
    // The native sub-runs carry their own mount's scope; the cross-mount
    // command as a whole is bounded by the strictest cap across the
    // operand mounts, regardless of which sub-run merged last.
    const mounts: MountEntry[] = []
    for (const s of pathScopes) {
      const m = registry.mountFor(s.virtual)
      if (m !== null) mounts.push(m)
    }
    csIo.producer = {
      command: cmdName,
      prefixes: mounts.map((m) => m.prefix),
      declared: null,
    }
    csExec.paths = pathScopes
    return [maybeWithTimeout(csStdout, resolveLimit(cmdName, mounts), cmdName), csIo, csExec]
  }

  // Path-flag targets count: a command bound to one mount cannot write its
  // output through another.
  if (routingScopes.length >= 2) {
    const mountPrefixes = new Set<string>()
    for (const s of routingScopes) {
      const m = registry.mountFor(s.virtual)
      if (m !== null) mountPrefixes.add(m.prefix)
    }
    if (mountPrefixes.size > 1) {
      const prefixesStr = [...mountPrefixes].sort().join(', ')
      const err = new TextEncoder().encode(
        `${cmdName}: paths span multiple mounts (${prefixesStr}), cross-mount not supported\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1 }),
      ]
    }
  }

  let mount: MountEntry | null
  try {
    mount = await registry.resolveMount(cmdName, routingScopes, session.cwd)
  } catch (err) {
    if (err instanceof MountCommandUnsupported) {
      const errBytes = new TextEncoder().encode(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
      ]
    }
    throw err
  }
  if (mount === null) {
    const err = new TextEncoder().encode(`${cmdName}: command not found`)
    return [
      null,
      new IOResult({ exitCode: 127, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 127 }),
    ]
  }
  try {
    assertMountAllowed(mount.prefix)
  } catch (err) {
    if (err instanceof MountNotAllowedError) {
      const errBytes = new TextEncoder().encode(`${cmdName}: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
      ]
    }
    throw err
  }

  const [
    paths,
    textsRaw,
    flagKwargs,
    parseWarnings,
    invalidOptions,
    ambiguousOptions,
    optionErrorKinds,
    needsValueOptions,
    invalidValueOptions,
    invalidIntOptions,
    invalidFloatOptions,
    missingRequiredOptions,
    oldOptionNeedsValue,
  ] = parseFlags(parts.slice(1), mount.specFor(cmdName), cmdName, session.cwd)
  const refusal = optionError(
    cmdName,
    invalidOptions,
    ambiguousOptions,
    optionErrorKinds,
    needsValueOptions,
    invalidValueOptions,
    invalidIntOptions,
    invalidFloatOptions,
    missingRequiredOptions,
    oldOptionNeedsValue,
  )
  if (refusal !== null) {
    const [msg, code] = refusal
    return [
      null,
      new IOResult({ exitCode: code, stderr: msg }),
      new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
    ]
  }
  const texts = findExprTokens ?? textsRaw
  if (findExprTokens !== null) {
    // `multiple: true` on find value-flags makes parseToKwargs emit arrays;
    // bespoke backend wrappers read these as scalars. Migrated backends read
    // the expression from `texts` and ignore flagKwargs.
    for (const [key, value] of Object.entries(flagKwargs)) {
      if (Array.isArray(value)) {
        const last = value.at(-1)
        if (last !== undefined) flagKwargs[key] = last
      }
    }
  }
  const warnBytes =
    parseWarnings.length > 0
      ? new TextEncoder().encode(parseWarnings.map((w) => `${cmdName}: ${w}\n`).join(''))
      : null

  if (ensureOpen !== undefined) {
    await ensureOpen(mount.resource)
  }

  if (shouldFanOut(cmdName, paths, flagKwargs, registry)) {
    const [fanOut, fanIo, fanNode] = await fanOutTraversal(
      cmdName,
      paths,
      texts,
      flagKwargs,
      registry,
      mount,
      session.cwd,
      cmdStr,
      stdin,
      ensureOpen,
    )
    if (warnBytes !== null) {
      const existing = await materialize(fanIo.stderr)
      fanIo.stderr = concatBytes([warnBytes, existing])
      fanNode.stderr = concatBytes([warnBytes, fanNode.stderr])
    }
    return [fanOut, fanIo, fanNode]
  }

  const runCtx: RunOnMountCtx = {
    registry,
    session,
    dispatch,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(ensureOpen !== undefined ? { ensureOpen } : {}),
    ...(runtimeBindings !== undefined ? { runtimeBindings } : {}),
    ...(routingDecision !== undefined ? { routingDecision } : {}),
  }
  const [rawStdout, io] = await runOnMount(runCtx, cmdName, paths, texts, flagKwargs, {
    stdin,
    mount,
    resolveHint: routingScopes[0] ?? null,
  })
  let stdout = rawStdout
  if (warnBytes !== null) {
    const existing = await materialize(io.stderr)
    io.stderr = concatBytes([warnBytes, existing])
  }
  const resolved =
    io.producer !== null
      ? resolveProducer(io.producer, (prefix, name) => registry.limitOverride(prefix, name))
      : null
  stdout = maybeWithTimeout(stdout, resolved, cmdName)
  io.stderr = maybeWithTimeout(io.stderr, resolved, cmdName)
  const stderrBytes = await materialize(io.stderr)
  const exec = new ExecutionNode({
    command: cmdStr,
    stderr: stderrBytes,
    exitCode: io.exitCode,
    paths,
  })
  return [stdout, io, exec]
}
