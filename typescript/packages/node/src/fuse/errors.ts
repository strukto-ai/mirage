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

// Positive POSIX errno values. FUSE callbacks want them negated; other
// kernel interfaces (FSKit) want them positive, so the classification is
// kept protocol-neutral here and adapters apply their own sign.
export const ENOENT = 2
export const EIO = 5
export const EACCES = 13
export const EEXIST = 17
export const EINVAL = 22
export const ENOTDIR = 20
export const EISDIR = 21
export const EROFS = 30
// macOS value; Linux is 39 — fuse-native normalizes.
export const ENOTEMPTY = 66
// A rename across mounts. The kernel reads this as "not one filesystem"
// and `mv` falls back to copy+unlink, so it must survive the trip out.
export const EXDEV = 18

const CODE_ERRNO: Record<string, number> = {
  ENOTEMPTY,
  ENOTDIR,
  EISDIR,
  EACCES,
  EEXIST,
  ENOENT,
  EINVAL,
  EROFS,
  EXDEV,
}

const MESSAGE_ERRNO: [string[], number][] = [
  [['not empty', 'enotempty'], ENOTEMPTY],
  [['not a directory', 'enotdir'], ENOTDIR],
  [['is a directory', 'eisdir'], EISDIR],
  // A session capability rejection (MountNotAllowedError) is a permission
  // failure, mirroring Python's PermissionError -> EACCES.
  [['not allowed to access mount'], EACCES],
  [['permission', 'eacces', 'read-only'], EACCES],
  [['file exists', 'eexist'], EEXIST],
  [['not found', 'no such', 'enoent', 'no mount'], ENOENT],
]

/**
 * Map a mirage-native error onto a positive POSIX errno.
 *
 * Mirrors Python's `mirage.fuse.errors.classify_error` so both languages
 * report the same errno for the same backend failure. The error `code`
 * property wins over the message, because backends raise a mix: some set a
 * code, others only a human-readable string.
 */
export function classifyErrno(err: unknown): number {
  const code = (err as { code?: string }).code
  if (code !== undefined) {
    const mapped = CODE_ERRNO[code]
    if (mapped !== undefined) return mapped
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  for (const [needles, errno] of MESSAGE_ERRNO) {
    if (needles.some((n) => msg.includes(n))) return errno
  }
  return EIO
}

/** Same classification, negated for `@zkochan/fuse-native` callbacks. */
export function classifyError(err: unknown): number {
  return -classifyErrno(err)
}

/**
 * Build an error carrying a POSIX code, so the mount core can signal a
 * specific errno without importing any adapter's numbering.
 */
export function errnoError(code: keyof typeof CODE_ERRNO, message: string): Error {
  return Object.assign(new Error(message), { code })
}
