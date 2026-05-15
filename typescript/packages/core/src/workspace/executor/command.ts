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

import type { CommandHistory } from '../../commands/config.ts'
import { parseCommand, parseToKwargs } from '../../commands/spec/parser.ts'
import { OperandKind } from '../../commands/spec/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { assertMountAllowed, MountNotAllowedError } from '../../runtime/session_context.ts'
import { CallStack } from '../../shell/call_stack.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import type { Mount } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { PyodideRuntime } from './python/runtime.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { asyncChain } from '../../io/stream.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCrossMount, isCrossMount } from './cross_mount.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import { handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'

const JOB_BUILTINS: ReadonlySet<string> = new Set(['wait', 'fg', 'kill', 'jobs', 'ps'])

type Result = [ByteSource | null, IOResult, ExecutionNode]

export class ReturnSignal extends Error {
  readonly exitCode: number
  constructor(exitCode: number) {
    super('return')
    this.name = 'ReturnSignal'
    this.exitCode = exitCode
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
  history?: CommandHistory,
  pythonRuntime?: PyodideRuntime,
): Promise<Result> {
  if (parts.length === 0) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  const head = parts[0]
  if (head === undefined) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  const cmdName = typeof head === 'string' ? head : head.original
  const cmdStr = parts.map((p) => (typeof p === 'string' ? p : p.original)).join(' ')

  if (JOB_BUILTINS.has(cmdName) && jobTable !== null) {
    const textParts = parts.map((p) => (typeof p === 'string' ? p : p.original))
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
  const textOnly = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.original))

  const rawArgv = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.original))
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

  if (unmount !== undefined && pathScopes.length === 1) {
    const intercept = await tryUnmountIntercept(cmdName, parts, pathScopes[0], registry, unmount)
    if (intercept !== null)
      return [null, intercept, new ExecutionNode({ command: cmdStr, exitCode: intercept.exitCode })]
  }

  if (isCrossMount(cmdName, pathScopes, registry)) {
    return handleCrossMount(cmdName, pathScopes, textOnly, dispatch, cmdStr)
  }

  if (pathScopes.length >= 2) {
    const mountPrefixes = new Set<string>()
    for (const s of pathScopes) {
      const m = registry.mountFor(s.original)
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

  const mount = await registry.resolveMount(cmdName, pathScopes, session.cwd)
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

  const [paths, texts, flagKwargs] = parseFlags(parts.slice(1), mount, cmdName, session.cwd)

  if (ensureOpen !== undefined) {
    await ensureOpen(mount.resource)
  }

  if (shouldFanOut(cmdName, paths, flagKwargs, registry)) {
    return fanOutTraversal(
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
  }

  try {
    const [initialStdout, io] = await mount.executeCmd(cmdName, paths, texts, flagKwargs, {
      stdin,
      cwd: session.cwd,
      dispatch,
      ...(history !== undefined ? { history } : {}),
      sessionId: session.sessionId,
      env: session.env,
      execAllowed: registry.isExecAllowed(),
      ...(pythonRuntime !== undefined ? { pythonRuntime } : {}),
    })
    let stdout = initialStdout
    if (cmdName === 'ls' && io.exitCode === 0) {
      stdout = await injectChildMounts(stdout, registry, paths, flagKwargs, session.cwd)
    }
    if (cmdName === 'find') {
      const [newStdout, actionErr] = await applyFindActions(
        stdout,
        flagKwargs,
        registry,
        session.cwd,
      )
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
    const prefix = mount.prefix.replace(/\/+$/, '')
    if (prefix !== '' && mount !== registry.defaultMount) {
      io.reads = prefixKeys(io.reads, prefix)
      io.writes = prefixKeys(io.writes, prefix)
      io.cache = io.cache.map((p) => prefix + p)
    }
    const stderrBytes = await materialize(io.stderr)
    const exec = new ExecutionNode({
      command: cmdStr,
      stderr: stderrBytes,
      exitCode: io.exitCode,
    })
    return [stdout, io, exec]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errBytes = new TextEncoder().encode(`${cmdName}: ${msg}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
    ]
  }
}

function parseFlags(
  parts: readonly (string | PathSpec)[],
  mount: Mount,
  cmdName: string,
  cwd: string,
): [PathSpec[], string[], Record<string, string | boolean>] {
  const argv: string[] = parts.map((item) => (item instanceof PathSpec ? item.original : item))
  const scopeMap = new Map<string, PathSpec>()
  for (const item of parts) {
    if (item instanceof PathSpec) {
      scopeMap.set(item.original, item)
      const stripped = item.original.replace(/\/+$/, '')
      if (stripped !== item.original) scopeMap.set(stripped, item)
    }
  }

  const spec = mount.specFor(cmdName)
  if (spec !== null) {
    const parsed = parseCommand(spec, argv, cwd)
    const flagKwargs = parseToKwargs(parsed)

    for (const [key, value] of Object.entries(flagKwargs)) {
      if (typeof value === 'string') {
        const match = scopeMap.get(value)
        if (match !== undefined) {
          flagKwargs[key] = match.original
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
              original: value,
              directory: slash >= 0 ? value.slice(0, slash + 1) : '/',
              resolved: true,
            }),
          )
        }
      } else {
        texts.push(value)
      }
    }
    return [paths, texts, flagKwargs]
  }

  const paths: PathSpec[] = []
  const texts: string[] = []
  for (const item of parts) {
    if (item instanceof PathSpec) paths.push(item)
    else texts.push(item)
  }
  return [paths, texts, {}]
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

const TRAVERSAL_CMDS: ReadonlySet<string> = new Set(['find', 'tree', 'du'])

function fnmatch(name: string, pattern: string): boolean {
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if ('.+^$(){}|\\'.includes(ch)) re += '\\' + ch
    else re += ch
  }
  return new RegExp('^' + re + '$').test(name)
}

async function applyFindActions(
  stdout: ByteSource | null,
  flagKwargs: Record<string, string | boolean>,
  registry: MountRegistry,
  cwd: string,
): Promise<[ByteSource | null, Uint8Array]> {
  const hasDelete = flagKwargs.delete === true
  const hasPrint0 = flagKwargs.print0 === true
  const hasLs = flagKwargs.ls === true
  const hasPrint = flagKwargs.print === true

  if (!hasDelete && !hasPrint0 && !hasLs) return [stdout, new Uint8Array()]
  if (stdout === null) return [stdout, new Uint8Array()]

  const data = await materialize(stdout)
  const text = new TextDecoder().decode(data)
  const matches = text.split('\n').filter((p) => p !== '')
  const errors: Uint8Array[] = []
  const enc = new TextEncoder()

  let outputMatches: string[]

  if (hasDelete) {
    const deletable = matches.filter((p) => !registry.isMountRoot(p))
    const ordered = [...deletable].sort(
      (a, b) => (b.match(/\//g) ?? []).length - (a.match(/\//g) ?? []).length,
    )
    for (const path of ordered) {
      const mount = registry.mountFor(path)
      if (mount === null) {
        errors.push(enc.encode(`find: cannot delete '${path}': no mount\n`))
        continue
      }
      const slash = path.lastIndexOf('/')
      const ps = new PathSpec({
        original: path,
        directory: slash >= 0 ? path.slice(0, slash + 1) : '/',
        resolved: true,
      })
      try {
        const [, rmIo] = await mount.executeCmd('rm', [ps], [], {}, { stdin: null, cwd })
        if (rmIo.exitCode !== 0) {
          const errBytes = await materialize(rmIo.stderr)
          if (errBytes.length > 0) errors.push(errBytes)
          else errors.push(enc.encode(`find: cannot delete '${path}'\n`))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(enc.encode(`find: cannot delete '${path}': ${msg}\n`))
      }
    }
    outputMatches = hasPrint ? matches : []
  } else if (hasLs) {
    outputMatches = []
    for (const path of matches) {
      const mount = registry.mountFor(path)
      if (mount === null) {
        errors.push(enc.encode(`find: cannot ls '${path}': no mount\n`))
        continue
      }
      const slash = path.lastIndexOf('/')
      const ps = new PathSpec({
        original: path,
        directory: slash >= 0 ? path.slice(0, slash + 1) : '/',
        resolved: true,
      })
      try {
        const [lsOut] = await mount.executeCmd(
          'ls',
          [ps],
          [],
          { args_l: true, d: true },
          { stdin: null, cwd },
        )
        if (lsOut !== null) {
          const line = new TextDecoder().decode(await materialize(lsOut)).replace(/\n+$/, '')
          if (line !== '') outputMatches.push(line)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(enc.encode(`find: cannot ls '${path}': ${msg}\n`))
      }
    }
  } else {
    outputMatches = matches
  }

  const errBlob = errors.length > 0 ? concat(errors) : new Uint8Array()
  if (outputMatches.length === 0) return [null, errBlob]

  let body: Uint8Array
  if (hasPrint0) {
    body = enc.encode(outputMatches.join('\x00') + '\x00')
  } else {
    body = enc.encode(outputMatches.join('\n') + '\n')
  }
  return [body, errBlob]
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function checkMountRootGuard(
  cmdName: string,
  paths: readonly PathSpec[],
  registry: MountRegistry,
  argv: readonly string[],
): GuardResult | null {
  if (paths.length === 0) return null
  const isRoot = (p: PathSpec): boolean => registry.isMountRoot(p.original)

  if (cmdName === 'rm' || cmdName === 'rmdir') {
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message:
            cmdName === 'rmdir'
              ? `rmdir: failed to remove '${p.original}': Device or resource busy\n`
              : `rm: cannot remove '${p.original}': Device or resource busy\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'mv') {
    if (paths[0] !== undefined && isRoot(paths[0])) {
      const dst = paths[1] !== undefined ? paths[1].original : '?'
      return {
        message: `mv: cannot move '${paths[0].original}' to '${dst}': Device or resource busy\n`,
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
          message: `mkdir: cannot create directory '${p.original}': File exists\n`,
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
          message: `touch: cannot touch '${p.original}': Is a directory\n`,
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
        message: `ln: failed to create link '${last.original}': File exists\n`,
        exitCode: 1,
      }
    }
    return null
  }

  return null
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
}

function shouldFanOut(
  cmdName: string,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, string | boolean>,
  registry: MountRegistry,
): boolean {
  if (paths.length === 0 || paths[0] === undefined) return false
  if (registry.descendantMounts(paths[0].original).length === 0) return false
  if (TRAVERSAL_CMDS.has(cmdName)) return true
  if (cmdName === 'grep') {
    return flagKwargs.r === true || flagKwargs.R === true || flagKwargs.recursive === true
  }
  if (cmdName === 'ls') {
    return flagKwargs.R === true
  }
  return false
}

function adjustDepthFlags(
  flagKwargs: Record<string, string | boolean>,
  parentPath: string,
  mountPrefix: string,
): Record<string, string | boolean> | null {
  const parentDepth = pathSegments(parentPath).length
  const mountDepth = pathSegments(mountPrefix).length
  const delta = mountDepth - parentDepth
  const out: Record<string, string | boolean> = { ...flagKwargs }
  if ('maxdepth' in out) {
    const orig = Number(out.maxdepth)
    if (!Number.isNaN(orig)) {
      const md = orig - delta
      if (md < 0) return null
      out.maxdepth = String(md)
    }
  }
  if ('mindepth' in out) {
    const orig = Number(out.mindepth)
    if (!Number.isNaN(orig)) {
      out.mindepth = String(Math.max(0, orig - delta))
    }
  }
  return out
}

function synthesizeFindMountEntries(
  targetPath: string,
  descendants: readonly Mount[],
  flagKwargs: Record<string, string | boolean>,
): string {
  const typeFilter = flagKwargs.type
  if (typeFilter !== undefined && typeFilter !== 'd') return ''
  const parentDepth = pathSegments(targetPath).length
  const maxRaw = flagKwargs.maxdepth
  const minRaw = flagKwargs.mindepth
  const maxDepth = maxRaw !== undefined ? Number(maxRaw) : null
  const minDepth = minRaw !== undefined ? Number(minRaw) : 0
  const namePat = typeof flagKwargs.name === 'string' ? flagKwargs.name : null
  const inamePat = typeof flagKwargs.iname === 'string' ? flagKwargs.iname : null
  const out: string[] = []
  for (const m of descendants) {
    const prefixNoSlash = m.prefix.replace(/\/+$/, '')
    const depth = pathSegments(prefixNoSlash).length - parentDepth
    if (depth < minDepth) continue
    if (maxDepth !== null && !Number.isNaN(maxDepth) && depth > maxDepth) continue
    const segs = prefixNoSlash.split('/').filter((s) => s !== '')
    const base = segs[segs.length - 1] ?? prefixNoSlash
    if (namePat !== null && !fnmatch(base, namePat)) continue
    if (inamePat !== null && !fnmatch(base.toLowerCase(), inamePat.toLowerCase())) continue
    out.push(prefixNoSlash)
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

async function fanOutTraversal(
  cmdName: string,
  paths: readonly PathSpec[],
  texts: readonly string[],
  flagKwargs: Record<string, string | boolean>,
  registry: MountRegistry,
  primaryMount: Mount,
  cwd: string,
  cmdStr: string,
  stdin: ByteSource | null,
  ensureOpen: ((resource: Resource) => Promise<void>) | undefined,
): Promise<Result> {
  const targetPath = paths[0]?.original ?? cwd
  const descendants = registry.descendantMounts(targetPath)
  const descendantPrefixes = descendants.map((m) => m.prefix.replace(/\/+$/, ''))

  const allStdout: Uint8Array[] = []
  let mergedIo = new IOResult()
  let finalExit = 0
  let successSeen = false

  const mountsToRun: Mount[] = [primaryMount, ...descendants]
  for (const mount of mountsToRun) {
    let subPaths: PathSpec[]
    let subFlags: Record<string, string | boolean>
    if (mount === primaryMount) {
      subPaths = [...paths]
      subFlags = { ...flagKwargs }
    } else {
      const adjusted = adjustDepthFlags(flagKwargs, targetPath, mount.prefix)
      if (adjusted === null) continue
      subFlags = adjusted
      const mountRoot = mount.prefix.replace(/\/+$/, '') || '/'
      subPaths = [
        new PathSpec({
          original: mountRoot,
          directory: mountRoot,
          prefix: mount.prefix.replace(/\/+$/, ''),
        }),
      ]
    }
    if (ensureOpen !== undefined) {
      try {
        await ensureOpen(mount.resource)
      } catch {
        continue
      }
    }
    let stdout: ByteSource | null
    let io: IOResult
    try {
      const result = await mount.executeCmd(cmdName, subPaths, [...texts], subFlags, {
        stdin,
        cwd,
      })
      stdout = result[0]
      io = result[1]
    } catch {
      continue
    }
    if (mount === primaryMount && descendantPrefixes.length > 0 && stdout !== null) {
      stdout = await filterUnderPrefixes(stdout, descendantPrefixes)
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
    const synthetic = synthesizeFindMountEntries(targetPath, descendants, flagKwargs)
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
  const stderrBytes = await materialize(mergedIo.stderr)
  const exec = new ExecutionNode({
    command: cmdStr,
    stderr: stderrBytes,
    exitCode: finalIoExit,
  })
  return [combined, mergedIo, exec]
}

async function injectChildMounts(
  stdout: ByteSource | null,
  registry: MountRegistry,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, string | boolean>,
  cwd: string,
): Promise<ByteSource | null> {
  if (flagKwargs.d === true || flagKwargs.R === true) return stdout
  if (paths.length > 1) return stdout
  const listed = paths.length === 1 && paths[0] !== undefined ? paths[0].original : cwd
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
  const textArgs = restParts.map((p) => (typeof p === 'string' ? p : p.original))
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

  const original = pathScope.original
  const stripped = original.replace(/^\/+|\/+$/g, '')
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
