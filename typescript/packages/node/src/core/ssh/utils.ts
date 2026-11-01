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

import { eisdir, enoent } from '@struktoai/mirage-core/errors/fs'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { lstripSlash, rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { S_IFDIR, S_IFMT, S_IFREG } from '@struktoai/mirage-core/utils/stat_view'
import type { OpenMode, SFTPWrapper } from 'ssh2'
import { FXF_CREAT, FXF_WRITE } from './constants.ts'

export function joinRoot(root: string, rel: string): string {
  const r = rstripSlash(root)
  const stripped = lstripSlash(rel)
  if (stripped === '') return r === '' ? '/' : r
  if (r === '') return `/${stripped}`
  return `${r}/${stripped}`
}

export function isNoSuchFile(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 2
}

// SSH_FX_PERMISSION_DENIED: the server's own access check refused the
// request, which the walk reports as EACCES against the path it named.
export function isPermissionDenied(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 3
}

// SFTP 3's one generic refusal (SSH_FX_FAILURE): the only vocabulary a
// version-3 server has for a not-empty rmdir, among other refusals.
export function isFailure(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 4
}

export function isDirectoryAttrs(attrs: { mode?: number }): boolean {
  if (attrs.mode === undefined) return false
  return (attrs.mode & S_IFMT) === S_IFDIR
}

export function isFileAttrs(attrs: { mode?: number }): boolean {
  if (attrs.mode === undefined) return false
  return (attrs.mode & S_IFMT) === S_IFREG
}

/**
 * Open a remote file with consistent filesystem errors.
 *
 * OpenSSH answers an open of a directory with SFTP 3's one generic refusal
 * (SSH_FX_FAILURE), so a stat decides whether it was one; a missing parent
 * is SSH_FX_NO_SUCH_FILE. Both leave in the errno every other backend uses.
 */
export async function openForWrite(
  sftp: SFTPWrapper,
  remote: string,
  p: PathSpec,
  flags: OpenMode | number = FXF_WRITE | FXF_CREAT,
): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolveFn, rejectFn) => {
      sftp.open(remote, flags, (err, opened) => {
        if (err) rejectFn(err)
        else resolveFn(opened)
      })
    })
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    if (isFailure(err)) {
      const isDir = await new Promise<boolean>((resolveFn) => {
        sftp.stat(remote, (statErr, attrs) => {
          resolveFn(statErr ? false : isDirectoryAttrs(attrs))
        })
      })
      if (isDir) throw eisdir(p)
    }
    throw err
  }
}

/**
 * Whether the remote directory still lists children. SFTP 3 answers a
 * not-empty rmdir with its one generic code (SSH_FX_FAILURE); this probe
 * decides between "not empty" and every other refusal that code covers. A
 * probe that fails is a negative probe, never an error to surface; the
 * caller re-raises what the server said. Mirrors Python's `holds_entries`.
 */
export async function holdsEntries(sftp: SFTPWrapper, remote: string): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolveFn, rejectFn) => {
      sftp.readdir(remote, (err, entries) => {
        if (err !== undefined) {
          rejectFn(err)
          return
        }
        resolveFn(entries.some((e) => e.filename !== '.' && e.filename !== '..'))
      })
    })
  } catch {
    return false
  }
}
