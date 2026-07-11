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
import { parseCommand, parseToKwargs } from '../../commands/spec/parser.ts'
import { missingValueError, unknownOptionError } from '../../commands/spec/usage.ts'
import { concatBytes } from '../../core/jq/format.ts'
import { OperandKind } from '../../commands/spec/types.ts'
import type { CommandSpec } from '../../commands/spec/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { assertMountAllowed, MountNotAllowedError } from '../../runtime/session_context.ts'
import { CallStack } from '../../shell/call_stack.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/types.ts'
import { PathSpec, wordText } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { Namespace } from '../mount/namespace.ts'
import { MountCommandUnsupported, type MountRegistry } from '../mount/registry.ts'
import { Consumer, JOB_BUILTINS, route } from '../route/index.ts'
import type { PyodideRuntime } from './python/runtime.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { asyncChain } from '../../io/stream.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCrossMount, isCrossMount } from './cross_mount.ts'
import type { RunSingle } from '../../commands/builtin/generic/crossmount/index.ts'
import { applyFindActions } from './find_action_dispatch.ts'
import { fanOutTraversal, shouldFanOut } from './fanout.ts'
import {
  FindParseError,
  findExprTail,
  parseFindExpression,
} from '../../commands/builtin/findParse.ts'
import { maybeWithTimeout } from '../../commands/builtin/utils/safeguard.ts'
import { resolveAcrossMounts, resolveSafeguard } from '../../commands/safeguard.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import { handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'
import { formatFsError } from '../../utils/errors.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]
type Flags = Record<string, string | boolean | string[]>

interface RunOnMountCtx {
  registry: MountRegistry
  session: Session
  dispatch: DispatchFn
  namespace?: Namespace
  ensureOpen?: (resource: Resource) => Promise<void>
  pythonRuntime?: PyodideRuntime
}

interface RunOnMountOpts {
  stdin?: ByteSource | null
  resolveHint?: PathSpec | null
  mount?: MountEntry | null
}

// `repeatable: true` on find value-flags makes parseToKwargs emit arrays;
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

// Run one already-parsed command on the mount that owns its paths. The shared
// single-mount execution tail: mount resolution, grant checks, executeCmd,
// filesystem-error formatting, ls/find post-processing, and read/write key
// prefixing. handleCommand uses it for the normal path, and passes it (bound)
// to the cross-mount runners so each operand executes natively on its owning
// mount. `resolveHint` resolves the mount when `paths` is empty (a stream
// command running in stdin mode); a pre-resolved `mount` skips resolution and
// grant checks, which the caller already performed.
async function runOnMount(
  ctx: RunOnMountCtx,
  cmdName: string,
  paths: PathSpec[],
  texts: string[],
  flagKwargs: Flags,
  opts: RunOnMountOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { registry, session, dispatch, namespace, ensureOpen, pythonRuntime } = ctx
  let mount = opts.mount ?? null
  if (mount === null) {
    const hint = opts.resolveHint ?? null
    const resolvePaths = paths.length > 0 ? paths : hint !== null ? [hint] : []
    try {
      mount = await registry.resolveMount(cmdName, resolvePaths, session.cwd)
    } catch (err) {
      if (err instanceof MountCommandUnsupported) {
        const errBytes = new TextEncoder().encode(`${err.message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
      }
      throw err
    }
    if (mount === null) {
      const errBytes = new TextEncoder().encode(`${cmdName}: command not found`)
      return [null, new IOResult({ exitCode: 127, stderr: errBytes })]
    }
    try {
      assertMountAllowed(mount.prefix)
      for (const ps of paths) {
        const target = registry.mountFor(ps.virtual)
        if (target !== null) assertMountAllowed(target.prefix)
      }
    } catch (err) {
      if (err instanceof MountNotAllowedError) {
        const errBytes = new TextEncoder().encode(`${cmdName}: ${err.message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
      }
      throw err
    }
  }

  let flags = flagKwargs
  if (cmdName === 'find') flags = scalarFindFlags(flags)

  if (ensureOpen !== undefined) {
    await ensureOpen(mount.resource)
  }

  // resolveMount may redirect a warm remote read to the cache mount, which
  // does not carry the origin mount's per-command safeguards. Resolve the
  // safeguard from the real (pre-redirect) mount so the cap survives the hit.
  const realMount = registry.mountFor(
    paths.length > 0 ? (paths[0]?.virtual ?? session.cwd) : session.cwd,
  )
  const safeguardOverride = realMount?.commandSafeguards.get(cmdName) ?? null

  try {
    const [initialStdout, io] = await mount.executeCmd(cmdName, paths, texts, flags, {
      stdin: opts.stdin ?? null,
      cwd: session.cwd,
      dispatch,
      sessionId: session.sessionId,
      env: session.env,
      execAllowed: registry.isExecAllowed(),
      ...(pythonRuntime !== undefined ? { pythonRuntime } : {}),
      safeguardOverride,
    })
    let stdout = initialStdout
    if (cmdName === 'ls' && io.exitCode === 0) {
      stdout = await injectChildMounts(stdout, registry, paths, flags, session.cwd)
      if (namespace !== undefined && namespace.symlinks.size > 0) {
        stdout = await injectLinks(stdout, namespace, paths, flags, session.cwd)
      }
    }
    if (cmdName === 'find') {
      const [newStdout, actionErr] = await applyFindActions(stdout, flags, registry, session.cwd)
      stdout = newStdout
      if (actionErr.length > 0) {
        const existing = await materialize(io.stderr)
        const merged = new Uint8Array(existing.length + actionErr.length)
        merged.set(existing, 0)
        merged.set(actionErr, existing.length)
        io.stderr = merged
        if (io.exitCode === 0) io.exitCode = 1
      }
    }
    const prefix = rstripSlash(mount.prefix)
    if (prefix !== '') {
      io.reads = prefixKeys(io.reads, prefix)
      io.writes = prefixKeys(io.writes, prefix)
      io.cache = io.cache.map((p) => prefix + p)
    }
    return [stdout, io]
  } catch (err) {
    return [null, new IOResult({ exitCode: 1, stderr: formatFsError(cmdName, err, paths) })]
  }
}

export class ReturnSignal extends Error {
  readonly exitCode: number
  readonly stderr: Uint8Array
  constructor(exitCode: number, stderr: Uint8Array = new Uint8Array()) {
    super('return')
    this.name = 'ReturnSignal'
    this.exitCode = exitCode
    this.stderr = stderr
  }
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
  unmount?: (prefix: string) => Promise<void>,
  pythonRuntime?: PyodideRuntime,
  namespace?: Namespace,
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
    if (cmdName === 'wait' || cmdName === 'fg') return handleWait(jobTable, textParts)
    if (cmdName === 'kill') return handleKill(jobTable, textParts)
    if (cmdName === 'jobs') return handleJobs(jobTable, textParts)
    if (cmdName === 'ps') return handlePs(jobTable, textParts)
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

  const pathScopes: PathSpec[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (p instanceof PathSpec) pathScopes.push(p)
  }
  const rawArgv = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.virtual))
  const guardResult = checkMountRootGuard(cmdName, pathScopes, registry, rawArgv)
  if (guardResult !== null) {
    const errBytes = new TextEncoder().encode(guardResult.message)
    return [
      null,
      new IOResult({ exitCode: guardResult.exitCode, stderr: errBytes }),
      new ExecutionNode({
        command: cmdStr,
        stderr: errBytes,
        exitCode: guardResult.exitCode,
      }),
    ]
  }

  // Unknown name: nobody registers it; fail like bash before any
  // backend work. The mount-root guard stays ahead of this so
  // protective refusals keep their specific messages.
  if (route(cmdName, session, registry) === Consumer.UNKNOWN) {
    const errBytes = new TextEncoder().encode(`${cmdName}: command not found\n`)
    return [
      null,
      new IOResult({ exitCode: 127, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, exitCode: 127, stderr: errBytes }),
    ]
  }

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

  if (unmount !== undefined && pathScopes.length === 1) {
    const intercept = await tryUnmountIntercept(cmdName, parts, pathScopes[0], registry, unmount)
    if (intercept !== null)
      return [null, intercept, new ExecutionNode({ command: cmdStr, exitCode: intercept.exitCode })]
  }

  if (isCrossMount(cmdName, pathScopes, registry)) {
    // Parse against the shared spec so flags and text operands do not
    // depend on the source mount: raw argv would hand flag tokens ("-c")
    // to the generic as the search pattern. The bound single-mount runner
    // lets the strategy runners execute each operand natively on its
    // owning mount.
    const csParsed = parseFlags(parts.slice(1), SPECS[cmdName] ?? null, cmdName, session.cwd)
    const csFlags = csParsed[2]
    const csTexts = findExprTokens ?? csParsed[1]
    const csRefusal = optionError(cmdName, csParsed[4], csParsed[5])
    if (csRefusal !== null) {
      const [msg, code] = csRefusal
      return [
        null,
        new IOResult({ exitCode: code, stderr: msg }),
        new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
      ]
    }
    const runCtx: RunOnMountCtx = {
      registry,
      session,
      dispatch,
      ...(namespace !== undefined ? { namespace } : {}),
      ...(ensureOpen !== undefined ? { ensureOpen } : {}),
      ...(pythonRuntime !== undefined ? { pythonRuntime } : {}),
    }
    const runSingle: RunSingle = (name, ps, ts, fk, opts) =>
      runOnMount(runCtx, name, ps, ts, fk, opts ?? {})
    const [csStdout, csIo, csExec] = await handleCrossMount(
      cmdName,
      pathScopes,
      csTexts,
      csFlags,
      dispatch,
      runSingle,
      stdin,
      cmdStr,
    )
    if (csParsed[3].length > 0) {
      const csWarn = new TextEncoder().encode(csParsed[3].map((w) => `${cmdName}: ${w}\n`).join(''))
      const csExisting = await materialize(csIo.stderr)
      csIo.stderr = concatBytes([csWarn, csExisting])
      csExec.stderr = concatBytes([csWarn, csExec.stderr])
    }
    // The native sub-runs carry their own mount's safeguard; the cross-mount
    // command as a whole uses the strictest one across the operand mounts,
    // regardless of which sub-run merged last.
    const mounts: MountEntry[] = []
    for (const s of pathScopes) {
      const m = registry.mountFor(s.virtual)
      if (m !== null) mounts.push(m)
    }
    csIo.safeguard =
      mounts.length > 0 ? resolveAcrossMounts(cmdName, mounts) : resolveSafeguard(cmdName)
    csExec.paths = pathScopes
    return [maybeWithTimeout(csStdout, csIo.safeguard, cmdName), csIo, csExec]
  }

  if (pathScopes.length >= 2) {
    const mountPrefixes = new Set<string>()
    for (const s of pathScopes) {
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
    mount = await registry.resolveMount(cmdName, pathScopes, session.cwd)
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

  const [paths, textsRaw, flagKwargs, parseWarnings, invalidOptions, needsValueOptions] =
    parseFlags(parts.slice(1), mount.specFor(cmdName), cmdName, session.cwd)
  const refusal = optionError(cmdName, invalidOptions, needsValueOptions)
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
    // `repeatable: true` on find value-flags makes parseToKwargs emit arrays;
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
    ...(pythonRuntime !== undefined ? { pythonRuntime } : {}),
  }
  const [rawStdout, io] = await runOnMount(runCtx, cmdName, paths, texts, flagKwargs, {
    stdin,
    mount,
  })
  let stdout = rawStdout
  if (warnBytes !== null) {
    const existing = await materialize(io.stderr)
    io.stderr = concatBytes([warnBytes, existing])
  }
  stdout = maybeWithTimeout(stdout, io.safeguard, cmdName)
  io.stderr = maybeWithTimeout(io.stderr, io.safeguard, cmdName)
  const stderrBytes = await materialize(io.stderr)
  const exec = new ExecutionNode({
    command: cmdStr,
    stderr: stderrBytes,
    exitCode: io.exitCode,
    paths,
  })
  return [stdout, io, exec]
}

// Single-mount dispatch and cross-mount dispatch both parse through here,
// so flags, texts, and parser warnings cannot drift between the two paths
// (a cross-mount `grep --bogus` used to lose its warning). The spec comes
// from the owning mount on the single-mount path and the shared SPECS
// registry on the cross-mount path.
function parseFlags(
  parts: readonly (string | PathSpec)[],
  spec: CommandSpec | null,
  cmdName: string,
  cwd: string,
): [
  PathSpec[],
  string[],
  Record<string, string | boolean | string[]>,
  string[],
  string[],
  string[],
] {
  const argv: string[] = parts.map((item) => (item instanceof PathSpec ? item.virtual : item))
  const scopeMap = new Map<string, PathSpec>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      scopeMap.set(item.virtual, item)
      const stripped = rstripSlash(item.virtual)
      if (stripped !== '' && stripped !== item.virtual) scopeMap.set(stripped, item)
    }
  }

  if (spec !== null) {
    const parsed = parseCommand(spec, argv, cwd)
    const flagKwargs = parseToKwargs(parsed)

    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) {
          flagKwargs[key] = match.virtual
        }
      }
    }

    const paths: PathSpec[] = []
    const texts: string[] = []
    for (const [value, kind] of parsed.args) {
      if (kind === OperandKind.PATH) {
        const existing = scopeMap.get(value)
        if (existing !== undefined) {
          paths.push(existing)
        } else {
          const slash = value.lastIndexOf('/')
          paths.push(
            new PathSpec({
              resourcePath: stripSlash(value),
              virtual: value,
              directory: slash >= 0 ? value.slice(0, slash + 1) : '/',
              resolved: true,
            }),
          )
        }
      } else {
        texts.push(value)
      }
    }
    return [
      paths,
      texts,
      flagKwargs,
      parsed.warnings,
      parsed.invalidOptions,
      parsed.needsValueOptions,
    ]
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return [paths, texts, {}, [], [], []]
}

// GNU-shaped refusal for option errors the parser reported. find is
// exempt: its expression tokens are validated by parseFindExpression,
// which raises the GNU predicate error itself.
function optionError(
  cmdName: string,
  invalid: readonly string[],
  needsValue: readonly string[],
): [Uint8Array, number] | null {
  if (cmdName === 'find') return null
  if (invalid.length > 0) return unknownOptionError(cmdName, invalid[0] ?? '')
  if (needsValue.length > 0) return missingValueError(cmdName, needsValue[0] ?? '')
  return null
}

function prefixKeys(obj: Record<string, ByteSource>, prefix: string): Record<string, ByteSource> {
  const out: Record<string, ByteSource> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[prefix + k] = v
  }
  return out
}

interface GuardResult {
  message: string
  exitCode: number
}

function checkMountRootGuard(
  cmdName: string,
  paths: readonly PathSpec[],
  registry: MountRegistry,
  argv: readonly string[],
): GuardResult | null {
  if (paths.length === 0) return null
  const isRoot = (p: PathSpec): boolean => registry.isMountRoot(p.virtual)

  if (cmdName === 'rm' || cmdName === 'rmdir') {
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message:
            cmdName === 'rmdir'
              ? `rmdir: failed to remove '${p.virtual}': Device or resource busy\n`
              : `rm: cannot remove '${p.virtual}': Device or resource busy\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'mv') {
    if (paths[0] !== undefined && isRoot(paths[0])) {
      const dst = paths[1] !== undefined ? paths[1].virtual : '?'
      return {
        message: `mv: cannot move '${paths[0].virtual}' to '${dst}': Device or resource busy\n`,
        exitCode: 1,
      }
    }
    return null
  }

  if (cmdName === 'mkdir') {
    for (const tok of argv) {
      if (tok === '-p' || tok === '--parents') return null
      if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('p')) return null
    }
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message: `mkdir: cannot create directory '${p.virtual}': File exists\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'touch') {
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message: `touch: cannot touch '${p.virtual}': Is a directory\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'ln') {
    const last = paths[paths.length - 1]
    if (last !== undefined && isRoot(last)) {
      return {
        message: `ln: failed to create link '${last.virtual}': File exists\n`,
        exitCode: 1,
      }
    }
    return null
  }

  return null
}

// Append symlink entries living under the listed directory. Links are
// namespace state, invisible to backend readdir, so `ls` surfaces them the
// same way child mounts are surfaced. Long form renders GNU-style
// `name -> target`.
async function injectLinks(
  stdout: ByteSource | null,
  namespace: Namespace,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  cwd: string,
): Promise<ByteSource | null> {
  if (flagKwargs.d === true || flagKwargs.R === true) return stdout
  if (paths.length > 1) return stdout
  const listed = paths.length === 1 && paths[0] !== undefined ? paths[0].virtual : cwd
  const links = namespace.linksUnder(listed)
  if (links.size === 0) return stdout

  const existing = stdout === null ? '' : new TextDecoder().decode(await materialize(stdout))
  const long = flagKwargs.args_l === true
  const classify = flagKwargs.F === true
  const present = new Set<string>()
  for (const line of existing.split('\n')) {
    if (line === '') continue
    const name = long ? (line.split('\t').pop() ?? '') : line.replace(/[/*@|=]$/, '')
    if (name !== '') present.add(name)
  }
  const extras: string[] = []
  for (const n of [...links.keys()].sort()) {
    if (present.has(n)) continue
    if (long) extras.push(`l\t-\t-\t${n} -> ${links.get(n) ?? ''}`)
    else extras.push(classify ? `${n}@` : n)
  }
  if (extras.length === 0) return stdout
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const combined = existing + sep + extras.join('\n') + '\n'
  return new TextEncoder().encode(combined)
}

async function injectChildMounts(
  stdout: ByteSource | null,
  registry: MountRegistry,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  cwd: string,
): Promise<ByteSource | null> {
  if (flagKwargs.d === true || flagKwargs.R === true) return stdout
  if (paths.length > 1) return stdout
  const listed = paths.length === 1 && paths[0] !== undefined ? paths[0].virtual : cwd
  const includeHidden = flagKwargs.a === true || flagKwargs.A === true
  const childNames = registry.childMountNames(listed, includeHidden)
  if (childNames.length === 0) return stdout

  const existing = stdout === null ? '' : new TextDecoder().decode(await materialize(stdout))
  const long = flagKwargs.args_l === true
  const classify = flagKwargs.F === true
  const present = new Set<string>()
  for (const line of existing.split('\n')) {
    if (line === '') continue
    const name = long ? (line.split('\t').pop() ?? '') : line.replace(/[/*@|=]$/, '')
    if (name !== '') present.add(name)
  }
  const extras: string[] = []
  for (const n of childNames) {
    if (present.has(n)) continue
    if (long) extras.push(`d\t-\t-\t${n}`)
    else extras.push(classify ? `${n}/` : n)
  }
  if (extras.length === 0) return stdout
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const combined = existing + sep + extras.join('\n')
  return new TextEncoder().encode(combined)
}

async function executeShellFunction(
  executeNode: ExecuteNodeFn,
  cmdName: string,
  body: unknown[],
  restParts: readonly (string | PathSpec)[],
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  const cs = callStack ?? new CallStack()
  // Positional args carry the word as typed ($1 stays sub/a.txt).
  const textArgs = restParts.map(wordText)
  cs.push(textArgs, cmdName)
  const savedLocals = new Map<string, string | null>()
  session.localVars = savedLocals
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: cmdName, exitCode: 0 })

  try {
    for (const cmd of body) {
      try {
        const cmdNode = cmd as Parameters<ExecuteNodeFn>[0]
        const [stdout, io, execNode] = await executeNode(cmdNode, session, stdin, cs)
        if (stdout !== null) allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
        lastExec = execNode
        if (
          io.exitCode !== 0 &&
          session.shellOptions.errexit === true &&
          !ERREXIT_EXEMPT_TYPES.has(cmdNode.type)
        ) {
          mergedIo.exitCode = io.exitCode
          break
        }
      } catch (err) {
        if (err instanceof ReturnSignal) {
          if (err.stderr.length > 0) {
            mergedIo = await mergedIo.merge(new IOResult({ stderr: err.stderr }))
          }
          mergedIo.exitCode = err.exitCode
          break
        }
        throw err
      }
    }
  } finally {
    cs.pop()
    for (const [key, oldVal] of savedLocals) {
      if (oldVal === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.env[key]
      } else {
        session.env[key] = oldVal
      }
    }
    session.localVars = null
  }

  const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
  lastExec.exitCode = mergedIo.exitCode
  return [combined, mergedIo, lastExec]
}

/**
 * If the command is a destructive op (rm -r/-R or rmdir) targeting a path
 * that exactly matches a mount prefix, treat it as an unmount instead of a
 * recursive delete. Mount roots are structural metadata; users typing
 * `rm -r /data` reach for the natural Unix-ish gesture to "remove this
 * directory" — for a mount, that's the unmount op.
 *
 * Returns null when the intercept does not apply.
 */
async function tryUnmountIntercept(
  cmdName: string,
  parts: readonly (string | PathSpec)[],
  pathScope: PathSpec | undefined,
  registry: MountRegistry,
  unmount: (prefix: string) => Promise<void>,
): Promise<IOResult | null> {
  if (pathScope === undefined) return null

  let recursive = false
  if (cmdName === 'rmdir') {
    recursive = true
  } else if (cmdName === 'rm') {
    for (const p of parts.slice(1)) {
      if (typeof p !== 'string') continue
      if (
        p === '-r' ||
        p === '-R' ||
        p === '-rf' ||
        p === '-Rf' ||
        p === '-rfR' ||
        p === '-fr' ||
        p === '-fR'
      ) {
        recursive = true
        break
      }
    }
  }
  if (!recursive) return null

  const original = pathScope.virtual
  const stripped = stripSlash(original)
  const norm = stripped ? `/${stripped}/` : '/'
  const matched = registry.mountForPrefix(norm)
  if (matched === null) return null

  try {
    await unmount(norm)
    return new IOResult({ exitCode: 0 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new IOResult({
      exitCode: 1,
      stderr: new TextEncoder().encode(`${cmdName}: ${msg}\n`),
    })
  }
}
