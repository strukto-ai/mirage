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

import { FileStat, FileType } from '@struktoai/mirage-core/types'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { isDirectoryAttrs } from './utils.ts'

export interface SshAttrs {
  size?: number
  mode?: number
  mtime?: number
  atime?: number
  uid?: number
  gid?: number
}

export function attrsToFileStat(name: string, attrs: SshAttrs): FileStat {
  const modified = attrs.mtime !== undefined ? new Date(attrs.mtime * 1000).toISOString() : null
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
  const atime = attrs.atime !== undefined ? new Date(attrs.atime * 1000).toISOString() : null
  // The remote mtime is the only cheap change token SFTP offers, so it is
  // also the fingerprint: without one, the ALWAYS consistency policy has
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
