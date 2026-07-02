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

// Accepts a PathSpec (reads .display, the as-typed form, falling back to
// .virtual) or a bare virtual-path string. Taking a structural shape avoids
// importing the PathSpec class (no import cycle). .display is always virtual
// (derived from the as-typed arg or .virtual), never a real fs path.
function virtualOf(path: string | { virtual: string; display?: string }): string {
  if (typeof path === 'string') return path
  return path.display ?? path.virtual
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
