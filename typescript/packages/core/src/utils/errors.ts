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

const STRERROR: Record<string, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
}

// GNU strerror text for a POSIX error code, or null if not a recognized
// filesystem code (so the chokepoint leaves the raw message untouched).
export function gnuStrerror(code: string | undefined): string | null {
  if (code === undefined) return null
  return STRERROR[code] ?? null
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
  const line =
    strerror !== null
      ? fsErrorLine(cmdName, spelled, err)
      : `${cmdName}: ${err instanceof Error ? err.message : String(err)}\n`
  return new TextEncoder().encode(line)
}
