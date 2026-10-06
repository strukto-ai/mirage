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

import type { Dirent } from 'node:fs'
import { constants, lstat, open, realpath, readdir, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { diskError } from './errors.ts'

export { gnuBasename as basename, norm, parent } from '@struktoai/mirage-core/utils/path'

export function resolveSafe(root: string, virtual: string): string {
  const relative = lstripSlash(virtual)
  const resolved = path.resolve(root, relative)
  const rootResolved = path.resolve(root)
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep)
  ) {
    throw new Error(`path escapes root: ${virtual}`)
  }
  return resolved
}

// Null when realpath fails. That happens alike for a missing component, a
// dangling link and a loop, so resolveInside's walk, which tells them apart,
// is what answers.
async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/**
 * The host path for a mount path, refused as absent when a component below
 * the root is a symlink. A VFS never stores a symlink, so a host link is not
 * an entry of the mount: following it would let a path the root admits
 * spelled-wise read or write wherever the link points on the host, and
 * `readdir` leaves it out so every walk agrees. Components past the first
 * absent one are left to the op, which answers its own ENOENT or creates.
 * Mirrors Python's resolve_inside.
 *
 * It answers for the tree as it stands when called. The mount's own writers
 * cannot make a host link (`ln -s` lands in the namespace), but another host
 * process that swaps a directory for a link between this check and the op
 * is beyond it: closing that race needs every op to walk by file descriptor
 * with O_NOFOLLOW (openat2's RESOLVE_BENEATH), which node:fs cannot express.
 *
 * @param root - the mount root on the host.
 * @param spec - the operand, the path any refusal names.
 * @param virtual - the mount-relative path, when not `spec.mountPath`.
 */
export async function resolveInside(
  root: string,
  spec: PathSpec,
  virtual: string = spec.mountPath,
): Promise<string> {
  const full = resolveSafe(root, virtual)
  const base = path.resolve(root)
  if (full === base) return full
  // A realpath or two instead of an lstat per component: a path that is its
  // own real location crosses no link at all, and one whose real location is
  // the root's plus the same relative path crosses none below the root.
  // Anything else (a link, a missing component, a case the filesystem folds)
  // is decided by the walk below, which reports its own errors.
  const real = await realOrNull(full)
  if (real === full) return full
  const realBase = await realOrNull(base)
  if (realBase !== null && real === path.join(realBase, path.relative(base, full))) return full
  let at = base
  for (const part of path.relative(at, full).split(path.sep)) {
    if (part === '') break
    at = path.join(at, part)
    let info
    try {
      info = await lstat(at)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return full
      throw diskError(err, spec)
    }
    if (info.isSymbolicLink()) throw enoent(spec)
  }
  return full
}

/**
 * Open a host file a state named, without following a link. A captured
 * file read later (a copy, a restore) is refused when a link or anything
 * but a regular file has replaced it since.
 */
export async function openRegular(file: string): Promise<FileHandle> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${file}`)
  } catch (err) {
    await handle.close()
    throw err
  }
  return handle
}

/** List visible entries without following host symlinks. All disk walks use this policy. */
export async function readEntries(directory: string): Promise<Dirent[]> {
  return (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => !entry.isSymbolicLink(),
  )
}
