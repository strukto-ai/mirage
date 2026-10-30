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

import type { Dirent, Stats } from 'node:fs'
import {
  constants,
  lstat,
  open,
  opendir,
  readdir,
  realpath,
  type FileHandle,
} from 'node:fs/promises'
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

async function nativeRealpath(file: string): Promise<string> {
  return realpath(file)
}

/**
 * Prove the requested spelling is the entry's own, listing the parent's names
 * only when nothing cheaper proves it. An ASCII name has one spelling unless
 * the directory folds case, and the name with one letter's case flipped tells:
 * absent, a link or another entry means the directory keeps case apart, so the
 * name that resolved is exact. Where it folds, a native path is trusted only
 * when the flipped, non-link spelling converges on the same full path whose
 * leaf is exactly the requested name. A name past ASCII may also fold or
 * normalize in ways one probe cannot see. Every proof that skips the listing
 * still opens the parent, so permissions stay uniform; no name cache. Mirrors
 * Python's exact_name.
 */
async function exactName(parent: string, part: string, info: Stats): Promise<boolean> {
  const index = part.search(/[A-Za-z]/)
  let alternate: string | undefined
  let folds = false
  if (index !== -1) {
    const char = part[index] ?? ''
    const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
    alternate = path.join(parent, part.slice(0, index) + flipped + part.slice(index + 1))
    try {
      const alias = await lstat(alternate)
      folds = !alias.isSymbolicLink() && alias.dev === info.dev && alias.ino === info.ino
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.debug('Disk spelling probe unavailable:', code)
        return (await readdir(parent)).includes(part)
      }
    }
  }
  if (/^\p{ASCII}*$/u.test(part) && !folds) {
    await openParent(parent)
    return true
  }
  if (folds && alternate !== undefined && ['darwin', 'win32'].includes(process.platform)) {
    try {
      const canonical = await nativeRealpath(path.join(parent, part))
      if (path.basename(canonical) === part && (await nativeRealpath(alternate)) === canonical) {
        await openParent(parent)
        return true
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES')
        console.debug('Native disk spelling proof unavailable:', code)
    }
  }
  return (await readdir(parent)).includes(part)
}

async function openParent(parent: string): Promise<void> {
  const listing = await opendir(parent, { bufferSize: 1 })
  try {
    await listing.read()
  } finally {
    await listing.close()
  }
}

/**
 * The host path for a mount path, refused as absent when a component below
 * the root is a symlink. A VFS never stores a symlink, so a host link is not
 * an entry of the mount: following it would let a path the root admits
 * spelled-wise read or write wherever the link points on the host, and
 * `readdir` leaves it out so every walk agrees. Components past the first
 * absent one are left to the op, which answers its own ENOENT or creates.
 * Fresh native proofs avoid sibling scans where supported; other names require
 * listing. Parents remain readable on both paths for uniform permissions.
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
  let at = base
  for (const part of path.relative(at, full).split(path.sep)) {
    if (part === '') break
    const parent = at
    at = path.join(parent, part)
    let info
    let exact
    try {
      info = await lstat(at)
      exact = info.isSymbolicLink() ? false : await exactName(parent, part, info)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return full
      throw diskError(err, spec)
    }
    if (!exact || info.isSymbolicLink()) throw enoent(spec)
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
