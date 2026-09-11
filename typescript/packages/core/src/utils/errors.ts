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

import { gnuPhrase } from '../errors/posix.ts'
import { dropTrailingSegments, respellOne } from './path.ts'
import { quotesOperands, shellQuote } from './quote.ts'
import { rstripSlash, stripSlash } from './slash.ts'

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

/** EBADF for a read of standard input that is closed or write-only;
 * python's BadDescriptorError, with `-` as the operand cat would name. */
export function ebadfStdin(): FsError {
  return fsError('-', 'EBADF')
}

export function ebusy(path: string | { virtual: string }): FsError {
  return fsError(path, 'EBUSY')
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

// readlink on a path that exists but is not a symlink. Mirrors Python's
// OSError(errno.EINVAL).
export function einval(path: string | { virtual: string }, message?: string): FsError {
  const err = fsError(path, 'EINVAL')
  if (message !== undefined) err.message = message
  return err
}

// A rename whose two ends sit on different mounts. POSIX's answer for a
// rename across filesystems, and the one a caller reads as "copy and
// unlink instead" (that is what makes `mv` work over a FUSE mount).
export function exdev(path: string | { virtual: string }): FsError {
  return fsError(path, 'EXDEV')
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
// readdirError directly.
// Mirrors Python's listing_error.
export async function listingError(
  path: string | { virtual: string; rawPath?: string },
  key: string,
  isFile: (p: string) => boolean | Promise<boolean>,
  isDir: (p: string) => boolean | Promise<boolean>,
): Promise<FsError> {
  if (stripSlash(key) !== '' && (await isFile(key))) return enotdir(path)
  return readdirError(path, key, isFile, isDir)
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

// A refused mutation that is not absence and not a mode: a lock or a
// policy in practice. Message-carrying, unlike `eacces`, because its
// callers name what was refused (the s3 batch delete names its count).
export function eaccesRefused(
  message: string,
  path: string | { virtual: string; rawPath?: string },
): FsError {
  const err = new Error(message) as FsError
  err.code = 'EACCES'
  err.virtualPath = virtualOf(path)
  return err
}

// The below-mode refusal keeps its human message (executor builtins and
// the FUSE bridge sniff 'read-only') but is stamped EROFS + operand so fs
// chokepoints render 'Read-only file system', matching Python's
// ReadOnlyError from the same guard: the mode voice, distinct from both
// the hide voice (ENOENT) and the policy voice (EACCES).
export function erofsReadOnly(
  message: string,
  path: string | { virtual: string; rawPath?: string },
): FsError {
  const err = new Error(message) as FsError
  err.code = 'EROFS'
  err.virtualPath = virtualOf(path)
  return err
}

// The phrases live once, in the posix table. The DOMAIN here stays
// deliberately narrower than the vocabulary: these are the per-operand
// codes a read-family command skips-and-reports, and widening it (say
// to ELOOP or EIO) would widen isFsError's swallow set, which mirrors
// python's typed FS_ERRORS tuple, not the whole condition enum.
const STRERROR: Record<string, string> = {
  // A read from a closed or write-only descriptor (`cat 0<&1`), raised
  // only by the shell's own unreadable stdin, not by any backend.
  EBADF: 'Bad file descriptor',
  ENOENT: gnuPhrase('ENOENT'),
  ENOTDIR: gnuPhrase('ENOTDIR'),
  EISDIR: gnuPhrase('EISDIR'),
  EROFS: gnuPhrase('EROFS'),
  EACCES: gnuPhrase('EACCES'),
  EEXIST: gnuPhrase('EEXIST'),
  ENOTEMPTY: gnuPhrase('ENOTEMPTY'),
  ENOTSUP: gnuPhrase('ENOTSUP'),
  EXDEV: gnuPhrase('EXDEV'),
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

// `enoent()` puts the *path* in the message, so matching on message text never
// fires; the stamped code is the only reliable signal. Python's twin is
// `except FileNotFoundError`. Three modules had grown their own copy of this.
export function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'ENOENT'
}

// Python's twin is `except IsADirectoryError`. GNU sometimes spells a
// directory read as something other than the EISDIR strerror (checksum
// --check says the literal "read error"), so callers need the code, not
// just the walk-error class.
export function isEisdir(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'EISDIR'
}

// Python's twin is `except FileExistsError`: the name is taken, which is
// the door's answer to a create that will not overwrite (symlink(2)).
export function isEexist(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'EEXIST'
}

// Python's twin is `except PermissionError`: a refusal (a rule at the
// command guard or the op door, a read-only mount), which a walk reports
// per entry the way GNU reports an unreadable one.
export function isEacces(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'EACCES'
}

// The mode gate's refusal (Python's `except ReadOnlyError`).
export function isErofs(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'EROFS'
}

// The path a stamped filesystem error blames (Python's `exc.filename`).
// A rename refuses on whichever endpoint stopped it, and the two are
// voiced differently, so the caller has to be able to tell them apart.
export function blamedPath(err: unknown): string | null {
  const virtual = (err as { virtualPath?: unknown }).virtualPath
  return typeof virtual === 'string' ? virtual : null
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
// A command in SHELL_QUOTED_COMMANDS reports the operand shell-quoted when
// it needs it ('*.txt'), the way GNU does; every other command reports it
// bare.
export function fsErrorLine(
  cmdName: string,
  path: string | { virtual: string; rawPath?: string },
  err: unknown,
): string {
  const label = quotesOperands(cmdName) ? shellQuote(virtualOf(path)) : virtualOf(path)
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
