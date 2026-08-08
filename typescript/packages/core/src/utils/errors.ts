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

import { dropTrailingSegments, respellOne } from './path.ts'
import { rstripSlash } from './slash.ts'

export interface FsError extends Error {
  code: string
  // The virtual path the user typed (PathSpec.virtual) — the ONLY path that
  // may ever reach a user-facing error message. Backends pass the PathSpec and
  // the helper reads .virtual, so a stripped path or real fs path can never
  // be stamped here by accident.
  virtualPath: string
}

// Accepts a PathSpec (reads .rawPath, the word's spelling, which defaults
// to .virtual) or a bare virtual-path string. Taking a structural shape
// avoids importing the PathSpec class (no import cycle). .rawPath is always
// a virtual-space path, never a real fs path.
function virtualOf(path: string | { virtual: string; rawPath?: string }): string {
  if (typeof path === 'string') return path
  return path.rawPath ?? path.virtual
}

function fsError(path: string | { virtual: string }, code: string): FsError {
  const virtual = virtualOf(path)
  const err = new Error(virtual) as FsError
  err.code = code
  err.virtualPath = virtual
  return err
}

// Mirrors Python's FileNotFoundError(virtual). The GNU strerror suffix
// ("No such file or directory") is appended once at the command chokepoints.
export function enoent(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOENT')
}

export function enotdir(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOTDIR')
}

export function eisdir(path: string | { virtual: string }): FsError {
  return fsError(path, 'EISDIR')
}

export function eexist(path: string | { virtual: string }): FsError {
  return fsError(path, 'EEXIST')
}

export function eacces(path: string | { virtual: string }): FsError {
  return fsError(path, 'EACCES')
}

export function enotempty(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOTEMPTY')
}

// The errno a failed directory listing should report. opendir reports ENOTDIR
// only when a component of the path exists and is not a directory (GNU
// `ls /f.txt/x` -> 'Not a directory'); a component that does not exist at all
// is ENOENT (`ls /nope` -> 'No such file or directory'), however deep it is.
// Store-backed backends have no kernel to draw that line for them, so they
// walk the ancestors and ask here instead of collapsing both cases into one
// errno. `key` is the mount-local normalized path that was looked up, isFile
// probes whether a mount-local path exists as a non-directory and isDir
// whether it exists as a directory. The walk stops at the first component
// that is neither, the way the kernel stops resolving there: a store can hold
// a key whose parent is not a directory, and looking past that gap would
// report ENOTDIR for a path the kernel never reaches.
// Mirrors Python's readdir_error.
export async function readdirError(
  path: string | { virtual: string; rawPath?: string },
  key: string,
  isFile: (p: string) => boolean | Promise<boolean>,
  isDir: (p: string) => boolean | Promise<boolean>,
): Promise<FsError> {
  const segments = key.split('/').filter((s) => s !== '')
  for (let i = 1; i <= segments.length; i++) {
    const component = `/${segments.slice(0, i).join('/')}`
    if (await isFile(component)) return enotdir(path)
    if (!(await isDir(component))) return enoent(path)
  }
  return enoent(path)
}

// The registry's refusal for a path that falls outside every mount. Mirrors
// Python's `ValueError("no mount matches path: ...")`; the stamp exists so
// the exists-family probes can recognize it without sniffing message text,
// and the message stays unstamped by a POSIX code so command stderr keeps
// rendering it verbatim (parity with Python, where ValueError is not an
// OSError and gets no strerror suffix).
export interface NoMountError extends Error {
  noMount: true
}

export function noMount(path: string): NoMountError {
  const err = new Error(`no mount matches path: ${path}`) as NoMountError
  err.noMount = true
  return err
}

// True when the error means the path is simply not there: a stamped ENOENT,
// or a path outside every mount. This is the whole swallow set for the
// exists-family probes, mirroring Python's `(FileNotFoundError, ValueError)`.
// Everything else — auth failures, transport errors, timeouts, ENOTDIR,
// backend bugs — must propagate instead of reading back as "missing".
export function isMissingPath(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const stamped = err as { code?: unknown; noMount?: unknown }
  return stamped.code === 'ENOENT' || stamped.noMount === true
}

// A missing-op error also names the op the backend did not register, so
// capability probes (metadata.ts) can test for one specific gap instead of
// sniffing message text.
export interface MissingOpError extends FsError {
  op: string
}

// A mount was asked for an op its backend does not register (e.g. unlink on
// a mail mount). ENOTSUP is the honest POSIX spelling for a capability gap:
// the fs chokepoints render GNU 'Operation not supported' against the
// operand, while the message keeps resource + op for tracebacks. Mirrors
// Python's OperationNotSupportedError/enotsup.
export function enotsup(
  resource: string,
  op: string,
  path: string | { virtual: string; rawPath?: string },
): MissingOpError {
  const err = new Error(`no op registered: ${op} for resource ${resource}`) as MissingOpError
  err.code = 'ENOTSUP'
  err.op = op
  err.virtualPath = virtualOf(path)
  return err
}

// True when the error is the missing-op stamp for this specific op — the
// capability probe used by fallback paths (metadata setattr, FUSE
// create/truncate) to distinguish "backend lacks the op" from a real
// failure inside it.
export function isMissingOp(err: unknown, op: string): boolean {
  const stamped = err as { code?: unknown; op?: unknown }
  return stamped.code === 'ENOTSUP' && stamped.op === op
}

// The read-only mount refusal keeps its human message (executor builtins
// and the FUSE bridge sniff 'read-only') but is stamped EACCES + operand so
// fs chokepoints render 'Permission denied', matching Python's
// PermissionError from the same guard.
export function eaccesReadOnly(
  message: string,
  path: string | { virtual: string; rawPath?: string },
): FsError {
  const err = new Error(message) as FsError
  err.code = 'EACCES'
  err.virtualPath = virtualOf(path)
  return err
}

// A missing-parent write refusal, keeping the backend's human message (tests
// and logs read 'parent directory does not exist') while stamping ENOENT +
// operand so fs chokepoints render 'No such file or directory'. Mirrors
// Python, which raises FileNotFoundError with the same prose — an untyped
// Error here leaked the prose to the user as if it were the path.
export function enoentWithMessage(
  message: string,
  path: string | { virtual: string; rawPath?: string },
): FsError {
  const err = new Error(message) as FsError
  err.code = 'ENOENT'
  err.virtualPath = virtualOf(path)
  return err
}

const STRERROR: Record<string, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ENOTSUP: 'Operation not supported',
}

// GNU strerror text for a POSIX error code, or null if not a recognized
// filesystem code (so the chokepoint leaves the raw message untouched).
export function gnuStrerror(code: string | undefined): string | null {
  if (code === undefined) return null
  return STRERROR[code] ?? null
}

// GNU strerror text for a thrown error, read from its stamped code
// (Python's fs_strerror). Null when the error is not a recognized fs error.
export function fsStrerror(err: unknown): string | null {
  return gnuStrerror((err as { code?: string }).code)
}

// The user-facing path for an error: the stamped virtualPath when present,
// else the raw message. Never a real fs path (backends never stamp those).
export function errorVirtualPath(err: unknown): string {
  const v = (err as { virtualPath?: unknown }).virtualPath
  if (typeof v === 'string') return v
  return err instanceof Error ? err.message : String(err)
}

// True when the error carries a recognized filesystem code, i.e. it is the
// per-operand kind a read-family command skips (GNU keeps processing the
// remaining operands). Anything else keeps propagating.
export function isFsError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && gnuStrerror(code) !== null
}

// The per-entry swallow set for walk-and-warn commands (ls, tree, rg):
// every stamped filesystem code plus the unstamped no-mount refusal.
// Mirrors Python's `except (OSError, ValueError)`, where ValueError is
// the no-mount spelling. Anything else — auth failures, transport
// errors, backend bugs — must propagate instead of vanishing from a
// listing or being laundered into a GNU-shaped 'cannot access' line.
export function isWalkError(err: unknown): boolean {
  return isFsError(err) || (err as { noMount?: unknown }).noMount === true
}

// Re-spell a reported path the way its operand was typed. Backends name paths
// in virtual space, but GNU quotes the operand as the user wrote it:
// `cd /data && mkdir -p f.txt/sub` reports 'f.txt', not '/data/f.txt'. The path
// an error names is the operand itself, an ancestor of it (mkdir -p blames the
// component of the chain it tripped on), or something under it, so all three
// are rebased onto rawPath. An absolute operand rebases to itself, which is why
// this is a no-op for most invocations. Mirrors Python's operand_spelling.
export function operandSpelling(
  path: string,
  operand: { virtual: string; rawPath?: string },
): string {
  const virtual = operand.virtual
  const raw = operand.rawPath ?? virtual
  if (raw === virtual) return path
  if (path === virtual) return raw
  const base = rstripSlash(virtual)
  if (path.startsWith(base + '/')) return respellOne(path, virtual, raw)
  const trimmed = rstripSlash(path)
  if (base.startsWith(trimmed + '/')) {
    const segments = (p: string): number => p.split('/').filter((s) => s !== '').length
    return dropTrailingSegments(raw, segments(base) - segments(trimmed))
  }
  return path
}

// GNU coreutils stderr line for one failed path operand, spelled as typed
// (PathSpec.rawPath). Byte-identical with the executor chokepoint and the
// Python fs_error_line. Used by read-family commands that keep processing
// remaining operands after one fails, where the caller holds the operand.
export function fsErrorLine(
  cmdName: string,
  path: string | { virtual: string; rawPath?: string },
  err: unknown,
): string {
  const label = virtualOf(path)
  const strerror = gnuStrerror((err as { code?: string }).code)
  if (strerror !== null) return `${cmdName}: ${label}: ${strerror}\n`
  return `${cmdName}: ${label}\n`
}

// The chokepoint variant of fsErrorLine for callers that only hold the
// error, byte-identical with Python's format_fs_error: the path is
// recovered from the error and, when `paths` is supplied, rewritten to the
// as-typed spelling (PathSpec.rawPath) so a relative argument is reported
// as typed, like GNU. Shared by the single-mount and cross-mount
// chokepoints; takes a structural shape to avoid importing PathSpec (no
// import cycle).
export function formatFsError(
  cmdName: string,
  err: unknown,
  paths?: readonly { virtual: string; rawPath: string }[],
): Uint8Array {
  const strerror = gnuStrerror((err as { code?: string }).code)
  const vpath = errorVirtualPath(err)
  const spelled = paths?.find((p) => p.virtual === vpath)?.rawPath ?? vpath
  let line: string
  if (strerror !== null) {
    line = fsErrorLine(cmdName, spelled, err)
  } else {
    // A message that already carries the `<cmd>: ` prefix (many generic
    // commands throw a fully GNU-formatted string, e.g. `uniq: invalid
    // count`) is emitted verbatim so the prefix is not doubled.
    const message = err instanceof Error ? err.message : String(err)
    line = message.startsWith(`${cmdName}: `) ? `${message}\n` : `${cmdName}: ${message}\n`
  }
  return new TextEncoder().encode(line)
}
