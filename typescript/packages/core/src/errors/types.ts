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

/**
 * A filesystem condition mirage can report, named once.
 *
 * Every boundary that has to say a condition in a number (POSIX for the
 * kernel adapters, preview1 for a WASI guest, CPython errnos for a
 * monty guest) keeps only a table from these names to its own numbers,
 * and nothing else. The POSIX table is the shared base and lives here;
 * each runtime dialect lives beside its boundary (`runtime/js/wasi.ts`,
 * `runtime/python/monty/errors.ts`). Every table stays total over this
 * union, and each table's own test fails a half-added member. The
 * spellings are the uppercase POSIX names because that is what `.code`
 * already carries throughout the TypeScript tree (python's enum uses
 * the same member names with lowercase values).
 *
 * One member is mirage's own condition rather than a POSIX spelling:
 * `NO_XATTR` is "attribute not set", which POSIX names ENOATTR on macOS
 * and ENODATA on Linux. `EBADF` is the shell's own: no mount raises it,
 * only a standard input that is closed or write-only.
 */
export type FsCondition =
  | 'EBADF'
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'ENOTEMPTY'
  | 'EXDEV'
  | 'ENOTSUP'
  | 'ELOOP'
  | 'EINVAL'
  | 'EIO'
  | 'EBUSY'
  | 'EROFS'
  | 'EFBIG'
  | 'NO_XATTR'

export const FS_CONDITIONS: readonly FsCondition[] = [
  'EBADF',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EACCES',
  'EPERM',
  'ENOTEMPTY',
  'EXDEV',
  'ENOTSUP',
  'ELOOP',
  'EINVAL',
  'EIO',
  'EBUSY',
  'EROFS',
  'EFBIG',
  'NO_XATTR',
]

/** One condition's POSIX rendering: errno plus strerror text. */
export interface PosixErrno {
  errno: number
  phrase: string
}

export interface FsError extends Error {
  code: string
  // The virtual path the user typed (PathSpec.virtual) — the ONLY path that
  // may ever reach a user-facing error message. Backends pass the PathSpec and
  // the helper reads .virtual, so a stripped path or real fs path can never
  // be stamped here by accident.
  virtualPath: string
}

/**
 * A path the kernel walk does not resolve: its own `.` and `..`
 * (`dotRefusal`), ENOENT or ENOTDIR at a name in front of a dot, or an
 * operand whose `walkError` the walk answered before the command ran
 * (`walkRefusal`), the empty name's ENOENT or a link loop's ELOOP.
 *
 * Final, which is why it is marked: a keyed store's plain miss can still be
 * an implicit directory, and the layers that ask (the read commands'
 * directory probes) re-read ENOENT that way, but a name in front of a dot
 * that is missing or a plain file is not a directory under any reading, and
 * neither is the empty name or a link loop. Every catch site keyed on the
 * code still sees its own. Mirrors Python's DotWalkError.
 */
export interface DotWalkError extends FsError {
  readonly dotWalk: true
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

// A missing-op error also names the op the backend did not register, so
// capability probes (metadata.ts) can test for one specific gap instead of
// sniffing message text.
export interface MissingOpError extends FsError {
  op: string
}
