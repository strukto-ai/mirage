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

import type { Stats } from 'ssh2'
import { FileStat, FileType, type PathSpec } from '@struktoai/mirage-core/types'
import { epochToIso } from '@struktoai/mirage-core/utils/dates'
import { eacces, enoent } from '@struktoai/mirage-core/errors/fs'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import {
  isDirectoryAttrs,
  isNoSuchFile,
  isPermissionDenied,
  joinRoot,
  stripPrefix,
} from './utils.ts'

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
  if (isDirectoryAttrs(attrs)) {
    return new FileStat({
      name,
      size: null,
      modified,
      fingerprint: modified,
      type: FileType.DIRECTORY,
      mode,
      atime,
      extra,
    })
  }
  return new FileStat({
    name,
    size: attrs.size ?? null,
    modified,
    fingerprint: modified,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    mode,
    atime,
    extra,
  })
}

export async function stat(accessor: SSHAccessor, p: PathSpec): Promise<FileStat> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
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
