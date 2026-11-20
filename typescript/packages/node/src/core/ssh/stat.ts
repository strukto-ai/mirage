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

import { eacces, enoent, exdev } from '@struktoai/mirage-core/errors/fs'
import { FileStat, FileType, type PathSpec } from '@struktoai/mirage-core/types'
import { epochToIso } from '@struktoai/mirage-core/utils/dates'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { parseTree, treeCommand } from '@struktoai/mirage-core/core/posix/stat'
import { joinRoot } from '@struktoai/mirage-core/core/posix/utils'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { posixNormpath } from '@struktoai/mirage-core/utils/path'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { modeType, S_IFDIR, S_IFREG } from '@struktoai/mirage-core/utils/stat_view'
import type { Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, isPermissionDenied, sftpCall } from './utils.ts'

const FIND_TYPES: Readonly<Record<string, number>> = { d: S_IFDIR, f: S_IFREG }

export interface SshAttrs {
  size?: number
  mode?: number
  mtime?: number
  atime?: number
  uid?: number
  gid?: number
}

export function attrsToFileStat(name: string, attrs: SshAttrs): FileStat {
  const modified = attrs.mtime !== undefined ? epochToIso(attrs.mtime) : null
  const extra: Record<string, unknown> = {}
  if (attrs.mode !== undefined) extra.mode = attrs.mode
  if (attrs.uid !== undefined) extra.uid = attrs.uid
  if (attrs.gid !== undefined) extra.gid = attrs.gid
  // Fields setattr applies natively (mode, times) surface from the
  // remote inode, so external chmod/utime stays visible, mirroring
  // disk. Ownership can never be applied natively (chown over SFTP
  // needs privileges), so it lives wholly in the namespace overlay;
  // server-side uid/gid stay in extra only.
  const mode = attrs.mode !== undefined ? attrs.mode & 0o7777 : null
  const atime = attrs.atime !== undefined ? epochToIso(attrs.atime) : null
  // The remote mtime is the only cheap change token SFTP offers, so it is
  // also the fingerprint: without one, a `read: fresh` mount has
  // nothing to compare and keeps serving a cached copy that the server has
  // already replaced. Mirrors the python stat.
  const type = modeType(attrs.mode) ?? FileType.FILE
  return new FileStat({
    name,
    size: type === FileType.DIRECTORY ? null : (attrs.size ?? null),
    modified,
    fingerprint: modified,
    type,
    content: type === FileType.FILE ? contentTypeForPath(name) : null,
    mode,
    atime,
    extra,
  })
}

export async function stat(accessor: SSHAccessor, p: PathSpec): Promise<FileStat> {
  const sftp = await accessor.sftp()
  const virtual = rawPathOf(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const attrs = await new Promise<Stats>((resolveFn, rejectFn) => {
    // Follow symlinks (stat, not lstat), like the Python core: reads
    // follow the link, so the reported size must be the target's.
    sftp.stat(remote, (err, stats) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) rejectFn(enoent(p))
        else rejectFn(isPermissionDenied(err) ? eacces(p) : err)
        return
      }
      resolveFn(stats)
    })
  })
  const cleaned = rstripSlash(virtual)
  const name = cleaned.length === 0 ? '/' : (cleaned.split('/').pop() ?? '/')
  return attrsToFileStat(name, attrs)
}

/** Resolve remote links to a key under the configured root. */
export async function realpath(accessor: SSHAccessor, path: PathSpec): Promise<string> {
  const sftp = await accessor.sftp()
  try {
    const root = posixNormpath(
      await sftpCall<string>((done) => {
        sftp.realpath(accessor.config.root ?? '/', done)
      }),
    )
    const remote = posixNormpath(
      await sftpCall<string>((done) => {
        sftp.realpath(joinRoot(root, rawPathOf(path)), done)
      }),
    )
    const prefix = rstripSlash(root) + '/'
    if (!root.startsWith('/') || (remote !== root && !remote.startsWith(prefix))) throw exdev(path)
    return remote === root ? '' : remote.slice(prefix.length)
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(path)
    if (isPermissionDenied(err)) throw eacces(path)
    throw err
  }
}

/**
 * Every file and directory under a directory, each as `stat` answers it, from
 * one find on the server, where a walk sends a readdir per directory.
 *
 * Only an exit of 0 with nothing on stderr, a directory at `p`, and entries
 * that are each a directory or a regular file answer: a server that runs no
 * commands, a find without `-printf` (busybox, BSD), an entry it could not
 * read, a link loop, a broken link or a special file leaves the walk to
 * readdir, which reports each as it does today. Mirrors Python's `tree`.
 */
export async function tree(
  accessor: SSHAccessor,
  p: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const scope = joinRoot(accessor.config.root ?? '/', rawPathOf(p))
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(treeCommand(scope))
  } catch (error) {
    console.debug(`ssh tree left to the walk: ${String(error)}`)
    return null
  }
  const found = status === 0 && err.length === 0 ? parseTree(out) : null
  if (found === null) return null
  const rows = new Map<string, FileStat>()
  let top = false
  for (const row of found) {
    const type = FIND_TYPES[row.kind]
    if (type === undefined) return null
    if (row.rel === '') {
      top = type === S_IFDIR
      continue
    }
    rows.set(
      row.rel,
      attrsToFileStat(row.rel.split('/').pop() ?? row.rel, {
        mode: type | row.mode,
        size: row.size,
        mtime: row.mtime,
        atime: row.atime,
      }),
    )
  }
  return top ? rows : null
}
