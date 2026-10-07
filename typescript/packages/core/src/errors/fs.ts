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

import { CODE_ARMS, OPERAND_CONDITIONS } from './constants.ts'
import { posixPhrase } from './posix.ts'
import type {
  DotWalkError,
  FsError,
  MissingOpError,
  NoMountError,
  StaleWriteError,
} from './types.ts'
import { stripSlash } from '../utils/slash.ts'

// Accepts a PathSpec (reads .rawPath, the word's spelling, which defaults
// to .virtual) or a bare virtual-path string. Taking a structural shape
// avoids importing the PathSpec class (no import cycle). .rawPath is always
// a virtual-space path, never a real fs path.
export function virtualOf(path: string | { virtual: string; rawPath?: string }): string {
  if (typeof path === 'string') return path
  return path.rawPath ?? path.virtual
}

// The error a mount raises for one code at one path: the code stamped, the
// operand as virtualPath, and the path itself as the message unless the
// caller names what was refused. Every constructor below is this one.
// Mirrors Python's fs_error.
export function fsError(
  path: string | { virtual: string },
  code: string,
  message?: string,
): FsError {
  const virtual = virtualOf(path)
  const err = new Error(message ?? virtual) as FsError
  err.code = code
  err.virtualPath = virtual
  return err
}

// Mirrors Python's enoent. The strerror suffix ("No such file or directory")
// is appended once at the command chokepoints.
export function enoent(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOENT')
}

/** EBADF for a read from a descriptor that is closed or write-only, named
 * as the reader names it (`-` for standard input). Mirrors Python's ebadf. */
export function ebadf(path: string | { virtual: string }): FsError {
  return fsError(path, 'EBADF')
}

/** EFBIG: a read the backend refuses to render whole (a records file past its
 * mount's record cap); python's FileTooLargeError. Per-operand, like ENOENT,
 * so a read-family command reports it and moves on. */
export function efbig(path: string | { virtual: string }): FsError {
  return fsError(path, 'EFBIG')
}

/** A conditional write the backend refused: the file changed since it was
 * read, or it exists and there is no version to send. Per-operand, so a
 * command reports it and moves on; never a read failure. Python's
 * StaleWriteError. */
export function staleWrite(path: string | { virtual: string }, landed = false): StaleWriteError {
  return Object.assign(fsError(path, 'STALE_WRITE'), { landed })
}

export function isLandedMove(err: unknown): err is StaleWriteError {
  return hasCode(err, 'STALE_WRITE') && (err as { landed?: unknown }).landed === true
}

export function ebusy(path: string | { virtual: string }): FsError {
  return fsError(path, 'EBUSY')
}

// ENOTDIR: a component of the path is a plain file. What open(2) and stat(2)
// answer for `a.txt/x`, and what a lookup there answers on ram, redis, disk
// and OPFS too: the keyed stores walk the parents on a miss (their
// lookupError), the filesystems hear it from the kernel. Deliberate
// divergence: object stores and SFTP answer ENOENT, because telling the two
// apart costs a request per ancestor on every miss, a stat miss is the
// ordinary case of a copy's destination probe, and an object store may hold
// `a.txt` and `a.txt/x` at once. Mirrors Python's enotdir.
export function enotdir(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOTDIR')
}

export function dotWalkError(
  path: string | { virtual: string },
  code: 'ENOENT' | 'ENOTDIR' | 'ELOOP',
): DotWalkError {
  return Object.assign(fsError(path, code), { dotWalk: true as const })
}

/** What an op raises for an operand the kernel walk did not resolve, named
 * as typed (the empty name included), since that is what the command
 * reports and `virtual` names the working directory for it. Mirrors
 * Python's walk_refusal. */
export function walkRefusal(path: {
  virtual: string
  rawPath: string
  walkError: 'ENOENT' | 'ELOOP' | null
}): DotWalkError {
  return dotWalkError(path, path.walkError ?? 'ENOENT')
}

/** ELOOP: a link loop stands in the path's walk. A walk refusal, so final
 * for every layer that re-reads a miss, and a coded fs error, so a
 * per-operand catch words it where the namespace's own CycleError escaped
 * every one. The door throws it for a loop above any name it is handed.
 * Mirrors Python's eloop. */
export function eloop(path: string | { virtual: string }): DotWalkError {
  return dotWalkError(path, 'ELOOP')
}

export function isDotWalkError(err: unknown): err is DotWalkError {
  return err instanceof Error && (err as { dotWalk?: unknown }).dotWalk === true
}

export function eisdir(path: string | { virtual: string }): FsError {
  return fsError(path, 'EISDIR')
}

export function eexist(path: string | { virtual: string }): FsError {
  return fsError(path, 'EEXIST')
}

// A refused mutation that is not absence and not a mode: a lock or a policy
// in practice. A caller may name what was refused (the s3 batch delete names
// its count).
export function eacces(path: string | { virtual: string }, message?: string): FsError {
  return fsError(path, 'EACCES', message)
}

// The below-mode refusal, stamped EROFS + operand so fs chokepoints render
// 'Read-only file system', matching Python's erofs from the same guard: the
// mode voice, distinct from both the hide voice (ENOENT) and the policy voice
// (EACCES). The message may say which mount (executor builtins sniff
// 'read-only').
export function erofs(path: string | { virtual: string }, message?: string): FsError {
  return fsError(path, 'EROFS', message)
}

// An extended attribute the path does not carry. ENODATA is linux's
// spelling; classify reads it, and macOS's ENOATTR, as NO_XATTR.
export function noXattr(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENODATA')
}

export function enotempty(path: string | { virtual: string }): FsError {
  return fsError(path, 'ENOTEMPTY')
}

// readlink on a path that exists but is not a symlink. Mirrors Python's
// OSError(errno.EINVAL).
export function einval(path: string | { virtual: string }, message?: string): FsError {
  return fsError(path, 'EINVAL', message)
}

// A rename whose two ends sit on different mounts. POSIX's answer for a
// rename across filesystems, and the one a caller reads as "copy and
// unlink instead" (that is what makes `mv` work over a FUSE mount).
export function exdev(path: string | { virtual: string }): FsError {
  return fsError(path, 'EXDEV')
}

// The errno a failed directory listing should report. opendir reports ENOTDIR
// only when a component of the path exists and is not a directory
// (`ls /f.txt/x` -> 'Not a directory'); a component that does not exist at all
// is ENOENT (`ls /nope` -> 'No such file or directory'), however deep it is.
// Store-backed backends have no kernel to draw that line for them, so they
// walk the ancestors and ask here instead of collapsing both cases into one
// errno. `key` is the mount-local normalized path that was looked up, isFile
// probes whether a mount-local path exists as a non-directory and isDir
// whether it exists as a directory. The walk stops at the first component
// that is neither, the way the kernel stops resolving there: a store can hold
// a key whose parent is not a directory, and looking past that gap would
// report ENOTDIR for a path the kernel never reaches.
// A component is tested as a directory FIRST, because a keyed store can hold
// both an object `a` and a prefix `a/` and traversal only ever reaches an
// intermediate component through the directory: with an object `a` and a key
// `a/x`, `ls /a/never` must report ENOENT, not ENOTDIR. On a store where the
// two are mutually exclusive the order is immaterial, so ram/redis/disk are
// unaffected.
// Every component is walked, the listed path included, because the walk is the
// only thing that can see a gap above it. A backend whose store cannot hold
// such a gap should call listingError instead, which settles the common case in
// one probe.
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
    if (await isDir(component)) continue
    if (await isFile(component)) return enotdir(path)
    return enoent(path)
  }
  return enoent(path)
}

// readdirError for a store that cannot hold an orphan. An object store's key
// implies every prefix of it, and a hierarchy the backend addresses by path
// implies every folder above it, so on those backends a path that exists proves
// its ancestors are directories and the answer for one that is not a directory
// is ENOTDIR outright. Probing it first is what keeps a readdir on a plain file
// to one round trip where each probe is an API request rather than a map lookup.
// That premise is exactly what a flat store breaks: ram and redis rename without
// creating the destination's ancestors, so they can hold `/missing/a.txt` with
// `/missing` absent, where resolution stops and the answer is ENOENT. Those call
// readdirError directly. The walk ends at the listed path itself, which the
// first probe has already found is not a file, so it is not asked again.
// Mirrors Python's listing_error.
export async function listingError(
  path: string | { virtual: string; rawPath?: string },
  key: string,
  isFile: (p: string) => boolean | Promise<boolean>,
  isDir: (p: string) => boolean | Promise<boolean>,
): Promise<FsError> {
  const leaf = stripSlash(key)
  if (leaf === '') return readdirError(path, key, isFile, isDir)
  if (await isFile(key)) return enotdir(path)
  return readdirError(path, key, (p) => stripSlash(p) !== leaf && isFile(p), isDir)
}

export function noMount(path: string): NoMountError {
  const err = new Error(`no mount matches path: ${path}`) as NoMountError
  err.noMount = true
  return err
}

// The registry's miss and nothing else: catch sites that cope with an
// unmounted path test this instead of swallowing every error, mirroring
// Python's `except NoMountError`.
export function isNoMount(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  return (err as { noMount?: unknown }).noMount === true
}

// What an existence probe reads as "nothing here": the path is absent, or
// a component of it is not traversable. Wider than isMissingPath below,
// which is the ENOENT-only swallow set, and still deliberately narrower
// than a walk's tolerance, because a permission or missing-capability
// error is not absence and mapping it to one would report a path that
// exists as missing. Mirrors python MISS_ERRORS, and lives here for the
// same reason that tuple does: the door and the executor's probes both
// read it and neither may import the other.
export function isMissError(exc: unknown): boolean {
  const code = (exc as { code?: string }).code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return true
  const msg = exc instanceof Error ? exc.message : String(exc)
  return /not found|no such file|not a directory|is a directory/i.test(msg)
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

// A mount was asked for an op its backend does not register (e.g. unlink on
// a mail mount). ENOTSUP is the honest POSIX spelling for a capability gap:
// the fs chokepoints render 'Operation not supported' against the
// operand, while the message keeps VFS + op for tracebacks. Mirrors
// Python's OperationNotSupportedError/enotsup.
export function enotsup(
  vfs: string,
  op: string,
  path: string | { virtual: string; rawPath?: string },
): MissingOpError {
  return Object.assign(fsError(path, 'ENOTSUP', `no op registered: ${op} for VFS ${vfs}`), {
    op,
  })
}

// True when the error is the missing-op stamp for this specific op — the
// capability probe used by fallback paths (metadata setattr, FUSE
// create/truncate) to distinguish "backend lacks the op" from a real
// failure inside it.
export function isMissingOp(err: unknown, op: string): boolean {
  const stamped = err as { code?: unknown; op?: unknown }
  return stamped.code === 'ENOTSUP' && stamped.op === op
}

// The phrase a command line ends with for a failed operand, read from the
// error's stamped code (Python's fs_strerror). Null for anything outside
// OPERAND_CONDITIONS, so the chokepoint leaves the raw message untouched.
export function fsStrerror(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null
  const condition = CODE_ARMS[code]
  if (condition === undefined || !OPERAND_CONDITIONS.has(condition)) return null
  return posixPhrase(condition)
}

// The user-facing path for an error: the stamped virtualPath when present,
// else the raw message. Never a real fs path (backends never stamp those).
export function errorVirtualPath(err: unknown): string {
  const v = (err as { virtualPath?: unknown }).virtualPath
  if (typeof v === 'string') return v
  return err instanceof Error ? err.message : String(err)
}

// True when the error carries a recognized filesystem code, i.e. it is the
// per-operand kind a read-family command skips, going on with the remaining
// operands. Anything else keeps propagating.
export function isFsError(err: unknown): boolean {
  return fsStrerror(err) !== null
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === code
}

// `enoent()` puts the *path* in the message, so matching on message text never
// fires; the stamped code is the only reliable signal. Python's twin is
// `except FileNotFoundError`. Three modules had grown their own copy of this.
export function isEnoent(err: unknown): boolean {
  return hasCode(err, 'ENOENT')
}

// Python's twin is `except NotADirectoryError`: a component of the path is
// a plain file, the other way a lookup fails besides ENOENT.
export function isEnotdir(err: unknown): boolean {
  return hasCode(err, 'ENOTDIR')
}

// Python's twin is `except FileTooLargeError`.
export function isEfbig(err: unknown): boolean {
  return hasCode(err, 'EFBIG')
}

// Python's twin is `except IsADirectoryError`. A command sometimes spells a
// directory read as something other than the EISDIR strerror (checksum
// --check says the literal "read error"), so callers need the code, not
// just the walk-error class.
export function isEisdir(err: unknown): boolean {
  return hasCode(err, 'EISDIR')
}

// Python's twin is `except FileExistsError`: the name is taken, which is
// the door's answer to a create that will not overwrite (symlink(2)).
export function isEexist(err: unknown): boolean {
  return hasCode(err, 'EEXIST')
}

// Python's twin is `except PermissionError`: a refusal (a rule at the
// command guard or the op door, a read-only mount), which a walk reports
// per entry the way it reports an unreadable one.
export function isEacces(err: unknown): boolean {
  return hasCode(err, 'EACCES')
}

// The mode gate's refusal (Python's `except ReadOnlyError`).
export function isErofs(err: unknown): boolean {
  return hasCode(err, 'EROFS')
}

// The per-entry swallow set for walk-and-warn commands (ls, tree, rg):
// every stamped filesystem code plus the unstamped no-mount refusal.
// Mirrors Python's `except (OSError, ValueError)`, where ValueError is
// the no-mount spelling. Anything else — auth failures, transport
// errors, backend bugs — must propagate instead of vanishing from a
// listing or being laundered into a 'cannot access' line.
export function isWalkError(err: unknown): boolean {
  return isFsError(err) || (err as { noMount?: unknown }).noMount === true
}
