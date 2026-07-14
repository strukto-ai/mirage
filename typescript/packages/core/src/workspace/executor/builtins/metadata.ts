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

import { IOResult } from '../../../io/types.ts'
import type { FileStat } from '../../../types.ts'
import { FileType, PathSpec } from '../../../types.ts'
import { CycleError, resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { DispatchFn } from '../cross_mount.ts'
import type { Namespace } from '../../mount/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

const MODE_CLASS_BITS: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 }
const MODE_PERM_BITS: Record<string, number> = { r: 0o444, w: 0o222, x: 0o111 }

function errorResult(cmd: string, message: string, exitCode = 1): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode, stderr: err }),
  ]
}

function okResult(cmd: string): Result {
  return [null, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
}

// Parse a chmod MODE argument (octal or symbolic). Symbolic supports the
// common grammar: `[ugoa...][+-=][rwx...]` clauses joined by commas
// (`u+x`, `go-w`, `a=r`, `+x`). Special bits (s, t, X) are not supported.
// Returns the new mode, or null when the text does not parse.
export function parseMode(text: string, current: number): number | null {
  if (/^[0-7]+$/.test(text)) {
    const value = parseInt(text, 8)
    return value <= 0o7777 ? value : null
  }
  let mode = current
  for (const clause of text.split(',')) {
    let i = 0
    let classes = ''
    while (i < clause.length && 'ugoa'.includes(clause.charAt(i))) {
      classes += clause.charAt(i)
      i += 1
    }
    const action = clause[i]
    if (action === undefined || !'+-='.includes(action)) return null
    i += 1
    const perms = clause.slice(i)
    if (!/^[rwx]*$/.test(perms)) return null
    let classMask = 0
    for (const c of classes.length > 0 ? classes : 'a') {
      classMask |= MODE_CLASS_BITS[c] ?? 0
    }
    let permMask = 0
    for (const c of perms) permMask |= MODE_PERM_BITS[c] ?? 0
    const bits = classMask & permMask
    if (action === '+') mode |= bits
    else if (action === '-') mode &= ~bits
    else mode = (mode & ~classMask) | bits
  }
  return mode
}

// Parse a chown OWNER[:GROUP] argument. Numeric ids become numbers; names
// are kept as strings (mirage has no user database; ownership is stored,
// not enforced). Each part is null when absent.
export function parseOwner(text: string): [number | string | null, number | string | null] {
  const sep = text.indexOf(':')
  const owner = sep >= 0 ? text.slice(0, sep) : text
  const group = sep >= 0 ? text.slice(sep + 1) : ''
  const uid = owner.length > 0 ? (/^\d+$/.test(owner) ? parseInt(owner, 10) : owner) : null
  const gid =
    sep >= 0 && group.length > 0 ? (/^\d+$/.test(group) ? parseInt(group, 10) : group) : null
  return [uid, gid]
}

// Resolve touch -t/-d into an ISO timestamp. `t` is a POSIX
// `[[CC]YY]MMDDhhmm[.ss]` stamp; `d` is a date string (ISO 8601). Returns
// null when neither flag is given; throws Error when the stamp is invalid.
export function parseTouchStamp(t: string | null, d: string | null): string | null {
  if (t !== null) {
    let raw = t
    let seconds = 0
    if (raw.includes('.')) {
      const dot = raw.indexOf('.')
      const secText = raw.slice(dot + 1)
      raw = raw.slice(0, dot)
      if (secText.length !== 2 || !/^\d+$/.test(secText)) throw new Error(t)
      seconds = parseInt(secText, 10)
    }
    if (!/^\d+$/.test(raw)) throw new Error(t)
    if (raw.length === 8) {
      raw = String(new Date().getUTCFullYear()).padStart(4, '0') + raw
    } else if (raw.length === 10) {
      const century = parseInt(raw.slice(0, 2), 10) < 69 ? '20' : '19'
      raw = century + raw
    }
    if (raw.length !== 12) throw new Error(t)
    const dt = new Date(
      Date.UTC(
        parseInt(raw.slice(0, 4), 10),
        parseInt(raw.slice(4, 6), 10) - 1,
        parseInt(raw.slice(6, 8), 10),
        parseInt(raw.slice(8, 10), 10),
        parseInt(raw.slice(10, 12), 10),
        seconds,
      ),
    )
    if (Number.isNaN(dt.getTime())) throw new Error(t)
    if (
      dt.getUTCMonth() !== parseInt(raw.slice(4, 6), 10) - 1 ||
      dt.getUTCDate() !== parseInt(raw.slice(6, 8), 10) ||
      dt.getUTCHours() !== parseInt(raw.slice(8, 10), 10) ||
      dt.getUTCMinutes() !== parseInt(raw.slice(10, 12), 10) ||
      seconds > 59
    ) {
      throw new Error(t)
    }
    return isoNoMs(dt)
  }
  if (d !== null) {
    let normalized = d.replace('Z', '+00:00').replace(' ', 'T')
    if (!normalized.includes('T')) normalized += 'T00:00:00'
    const hasZone = /[+-]\d{2}:\d{2}$/.test(normalized)
    const dt = new Date(hasZone ? normalized : normalized + '+00:00')
    if (Number.isNaN(dt.getTime())) throw new Error(d)
    return isoNoMs(dt)
  }
  return null
}

function isoNoMs(dt: Date): string {
  return dt.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function nowIso(): string {
  return isoNoMs(new Date())
}

interface SplitValueFlags {
  flags: Set<string>
  values: Map<string, string>
  operands: (string | PathSpec)[]
  bad: string | null
}

// Split leading flags where some take a value (`-t STAMP`).
function splitValueFlags(
  args: readonly (string | PathSpec)[],
  boolean: string,
  valued: string,
): SplitValueFlags {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) break
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing && s === '--') {
      parsing = false
      i += 1
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && !s.startsWith('--')) {
      const body = s.slice(1)
      let bad: string | null = null
      for (const c of body) {
        if (!boolean.includes(c) && !valued.includes(c)) {
          bad = c
          break
        }
      }
      if (bad !== null) return { flags, values, operands, bad }
      for (let j = 0; j < body.length; j++) {
        const c = body.charAt(j)
        if (boolean.includes(c)) {
          flags.add(c)
          continue
        }
        const rest = body.slice(j + 1)
        if (rest.length > 0) {
          values.set(c, rest)
        } else if (i + 1 < args.length) {
          i += 1
          const nxt = args[i]
          if (nxt !== undefined) {
            values.set(c, nxt instanceof PathSpec ? nxt.rawPath : nxt)
          }
        }
        break
      }
      i += 1
      continue
    }
    parsing = false
    operands.push(arg)
    i += 1
  }
  return { flags, values, operands, bad: null }
}

interface ResourceWithGlob {
  glob(paths: readonly PathSpec[], prefix?: string): Promise<PathSpec[]>
}

function hasGlob(r: object): r is ResourceWithGlob {
  return 'glob' in r && typeof (r as { glob?: unknown }).glob === 'function'
}

// Coerce operands to PathSpec and expand glob patterns per mount.
async function expandOperands(
  namespace: Namespace,
  operands: readonly (string | PathSpec)[],
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  for (const item of operands) {
    const spec = item instanceof PathSpec ? item : PathSpec.fromStrPath(item)
    if (spec.pattern !== null) {
      const mount = namespace.mountFor(spec.virtual)
      if (mount !== null && hasGlob(mount.resource)) {
        const prefix = rstripSlash(mount.prefix)
        const withPrefix = new PathSpec({
          virtual: spec.virtual,
          directory: spec.directory,
          pattern: spec.pattern,
          resolved: spec.resolved,
          resourcePath: mountKey(spec.virtual, prefix),
        })
        const expanded = await mount.resource.glob([withPrefix], prefix)
        for (const p of expanded) if (p instanceof PathSpec) out.push(p)
        continue
      }
    }
    out.push(spec)
  }
  return out
}

// Render the mirage read-only refusal for a metadata write.
function readOnlyError(cmd: string, namespace: Namespace, path: PathSpec): string {
  const prefix = namespace.mountFor(path.virtual)?.prefix ?? '/'
  return `${cmd}: read-only mount at ${prefix}\n`
}

function isReadOnlyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('read-only')
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'ENOENT'
}

interface SetAttrFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

function isMissingOp(err: unknown, op: string): boolean {
  return err instanceof Error && err.message.startsWith(`no op registered: ${op}`)
}

// Apply attributes natively when the mount supports setattr, else into the
// namespace overlay (durable, snapshot-captured namespace state). Unlike
// Python (which asks the mount upfront), ops resolve in the workspace
// OpsRegistry here, so the probe is the dispatch itself: only the
// registry's own missing-op error routes to the overlay.
async function setattrVia(
  namespace: Namespace,
  dispatch: DispatchFn,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<void> {
  try {
    await dispatch('setattr', path, [], fields as Record<string, unknown>)
    return
  } catch (err) {
    if (!isMissingOp(err, 'setattr')) throw err
  }
  const { mtime, ...rest } = fields
  namespace.setAttrs(path.virtual, {
    ...rest,
    ...(mtime !== undefined ? { mtime: new Date(mtime).getTime() / 1000 } : {}),
  })
}

function joinedError(cmd: string, errors: string[], exitCode: number): Result {
  const err = new TextEncoder().encode(errors.join(''))
  return [
    null,
    new IOResult({ exitCode, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode, stderr: err }),
  ]
}

// chmod MODE FILE...: set permission bits via setattr. Follows symlinks
// (GNU chmod always dereferences). Stored, not enforced: mount mode does
// real access control.
export async function handleChmod(
  namespace: Namespace,
  dispatch: DispatchFn,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, operands, bad } = splitValueFlags(args, 'Rvf', '')
  if (bad !== null) return errorResult('chmod', `chmod: invalid option -- '${bad}'\n`, 2)
  if (operands.length < 2) return errorResult('chmod', 'chmod: missing operand\n', 2)
  const first = operands[0]
  if (first === undefined) return errorResult('chmod', 'chmod: missing operand\n', 2)
  const modeText = first instanceof PathSpec ? first.virtual : first
  if (flags.has('R')) return errorResult('chmod', 'chmod: -R is not supported\n', 2)
  if (parseMode(modeText, 0) === null) {
    return errorResult('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
  }

  let exitCode = 0
  const errors: string[] = []
  for (const target of await expandOperands(namespace, operands.slice(1))) {
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`chmod: cannot access '${target.rawPath}': Too many levels of symbolic links\n`)
        exitCode = 1
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    let stat: FileStat
    try {
      const [result] = await dispatch('stat', resolved)
      stat = result as FileStat
    } catch (err) {
      if (isEnoent(err)) {
        errors.push(`chmod: cannot access '${target.rawPath}': No such file or directory\n`)
        exitCode = 1
        continue
      }
      throw err
    }
    // Backends without a mode default to what ls renders: 755 for
    // directories, 644 for files (symbolic clauses build on this).
    const current = stat.mode ?? (stat.type === FileType.DIRECTORY ? 0o755 : 0o644)
    const newMode = parseMode(modeText, current)
    if (newMode === null) {
      return errorResult('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
    }
    try {
      await setattrVia(namespace, dispatch, resolved, { mode: newMode })
    } catch (err) {
      if (!isReadOnlyError(err)) throw err
      errors.push(readOnlyError('chmod', namespace, resolved))
      exitCode = 1
    }
  }
  if (errors.length > 0) return joinedError('chmod', errors, exitCode)
  return okResult('chmod')
}

// chown OWNER[:GROUP] FILE...: set ownership via setattr. Ownership is
// stored, not enforced (mirage has no user model); names are kept
// verbatim, numeric ids become numbers.
export async function handleChown(
  namespace: Namespace,
  dispatch: DispatchFn,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, operands, bad } = splitValueFlags(args, 'Rvfh', '')
  if (bad !== null) return errorResult('chown', `chown: invalid option -- '${bad}'\n`, 2)
  if (operands.length < 2) return errorResult('chown', 'chown: missing operand\n', 2)
  if (flags.has('R')) return errorResult('chown', 'chown: -R is not supported\n', 2)
  const first = operands[0]
  if (first === undefined) return errorResult('chown', 'chown: missing operand\n', 2)
  const ownerText = first instanceof PathSpec ? first.virtual : first
  const [uid, gid] = parseOwner(ownerText)
  if (uid === null && gid === null) {
    return errorResult('chown', `chown: invalid spec: '${ownerText}'\n`, 1)
  }

  const noDeref = flags.has('h')
  let exitCode = 0
  const errors: string[] = []
  for (const target of await expandOperands(namespace, operands.slice(1))) {
    if (noDeref && namespace.isLink(target.virtual)) {
      namespace.setAttrs(target.virtual, {
        ...(uid !== null ? { uid } : {}),
        ...(gid !== null ? { gid } : {}),
      })
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`chown: cannot access '${target.rawPath}': Too many levels of symbolic links\n`)
        exitCode = 1
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    try {
      await dispatch('stat', resolved)
    } catch (err) {
      if (isEnoent(err)) {
        errors.push(`chown: cannot access '${target.rawPath}': No such file or directory\n`)
        exitCode = 1
        continue
      }
      throw err
    }
    try {
      await setattrVia(namespace, dispatch, resolved, {
        ...(uid !== null ? { uid } : {}),
        ...(gid !== null ? { gid } : {}),
      })
    } catch (err) {
      if (!isReadOnlyError(err)) throw err
      errors.push(readOnlyError('chown', namespace, resolved))
      exitCode = 1
    }
  }
  if (errors.length > 0) return joinedError('chown', errors, exitCode)
  return okResult('chown')
}

// touch: set access/modification times, creating missing files. GNU flags:
// -a/-m select which times, -c no-create, -h no-dereference (writes the
// link node's own mtime), -t STAMP / -d STRING supply the time, -r FILE
// copies times from a reference file.
export async function handleTouch(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: Session,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, values, operands, bad } = splitValueFlags(args, 'acmh', 'tdr')
  if (bad !== null) return errorResult('touch', `touch: invalid option -- '${bad}'\n`, 2)
  if (operands.length === 0) return errorResult('touch', 'touch: missing file operand\n', 1)

  let stamp: string | null
  try {
    stamp = parseTouchStamp(values.get('t') ?? null, values.get('d') ?? null)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return errorResult('touch', `touch: invalid date format '${text}'\n`, 1)
  }
  const refText = values.get('r')
  if (stamp === null && refText !== undefined) {
    const ref = PathSpec.fromStrPath(resolvePath(refText, session.cwd))
    try {
      const [refStat] = await dispatch('stat', ref)
      stamp = (refStat as FileStat).modified
    } catch (err) {
      if (isEnoent(err)) {
        return errorResult(
          'touch',
          `touch: failed to get attributes of '${refText}': No such file or directory\n`,
        )
      }
      throw err
    }
  }
  stamp ??= nowIso()

  const setAtime = flags.has('a') || !flags.has('m')
  const setMtime = flags.has('m') || !flags.has('a')

  let exitCode = 0
  const errors: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const target of await expandOperands(namespace, operands)) {
    if (namespace.isMountRoot(target.virtual)) {
      errors.push(`touch: cannot touch '${target.rawPath}': Is a directory\n`)
      exitCode = 1
      continue
    }
    if (flags.has('h') && namespace.isLink(target.virtual)) {
      namespace.setAttrs(target.virtual, { mtime: new Date(stamp).getTime() / 1000 })
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`touch: cannot touch '${target.rawPath}': Too many levels of symbolic links\n`)
        exitCode = 1
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    try {
      try {
        await dispatch('stat', resolved)
      } catch (err) {
        if (!isEnoent(err)) throw err
        if (flags.has('c')) continue
        try {
          await dispatch('write', resolved, [new Uint8Array(0)])
        } catch (werr) {
          // Stat-only backend (e.g. an API surface): creation is
          // impossible, which GNU reports as EROFS.
          if (!isMissingOp(werr, 'write')) throw werr
          errors.push(`touch: cannot touch '${target.rawPath}': Read-only file system\n`)
          exitCode = 1
          continue
        }
        writes[resolved.virtual] = new Uint8Array(0)
      }
      const fields: SetAttrFields = {}
      if (setAtime) fields.atime = stamp
      if (setMtime) fields.mtime = stamp
      await setattrVia(namespace, dispatch, resolved, fields)
    } catch (err) {
      if (!isReadOnlyError(err)) throw err
      errors.push(readOnlyError('touch', namespace, resolved))
      exitCode = 1
    }
  }
  const io = new IOResult({ exitCode, writes })
  const node = new ExecutionNode({ command: 'touch', exitCode })
  if (errors.length > 0) {
    const err = new TextEncoder().encode(errors.join(''))
    io.stderr = err
    node.stderr = err
  }
  return [null, io, node]
}
