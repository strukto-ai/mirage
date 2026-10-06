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

import type { FileEntryWithStats, Stats } from 'ssh2'
import { IndexEntry, ResourceType } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { epochToIso } from '@struktoai/mirage-core/utils/dates'
import { eacces, listingError } from '@struktoai/mirage-core/errors/fs'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import type { SshAttrs } from './stat.ts'
import {
  isDirectoryAttrs,
  isFileAttrs,
  isNoSuchFile,
  isPermissionDenied,
  joinRoot,
  stripPrefix,
} from './utils.ts'

async function attrsOrNull(accessor: SSHAccessor, key: string): Promise<Stats | null> {
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', key)
  return await new Promise<Stats | null>((resolveFn, rejectFn) => {
    sftp.stat(remote, (err, stats) => {
      if (err !== undefined) {
        // SFTP 3 has one code for every unresolvable name, so a component
        // under a file arrives as NO_SUCH_FILE just like one that is simply
        // absent. Both mean "this name does not resolve", which is what a
        // probe asks.
        if (isNoSuchFile(err)) resolveFn(null)
        else rejectFn(err)
        return
      }
      resolveFn(stats)
    })
  })
}

async function isFile(accessor: SSHAccessor, key: string): Promise<boolean> {
  const attrs = await attrsOrNull(accessor, key)
  return attrs !== null && !isDirectoryAttrs(attrs)
}

async function isDir(accessor: SSHAccessor, key: string): Promise<boolean> {
  const attrs = await attrsOrNull(accessor, key)
  return attrs !== null && isDirectoryAttrs(attrs)
}

export async function readdir(
  accessor: SSHAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const mountPrefix = mountPrefixOf(p.virtual, p.vfsPath)
  const virtual = p.pattern !== null ? p.directory.slice(mountPrefix.length) || '/' : stripPrefix(p)
  const base = `/${stripSlash(virtual)}`
  const virtualKey = rstripSlash(`${mountPrefix}${base}`) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const list = await new Promise<FileEntryWithStats[] | null>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) resolveFn(null)
        else rejectFn(isPermissionDenied(err) ? eacces(p) : err)
        return
      }
      resolveFn(entries)
    })
  })
  if (list === null) {
    throw await listingError(
      p,
      virtual,
      (key) => isFile(accessor, key),
      (key) => isDir(accessor, key),
    )
  }
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const found = list
    .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
    .sort((x, y) => compareCodePoints(x.filename, y.filename))
  const names = found.map((entry) => `${mountPrefix}${dirPrefix}${entry.filename}`)
  if (index !== undefined) {
    // SFTP readdir already returns each entry's attrs, so the listing keeps
    // type, size and mtime rather than discarding them. The attrs are
    // lstat-style: only a regular file gets a size, since a symlink's
    // link-text length is not what stat (which follows) or read serve.
    // Mirrors the python readdir.
    await index.setDir(
      virtualKey,
      found.map((entry) => {
        // ssh2 types every field as present, but a server may leave the
        // times (or size) out of a readdir entry; read them as optional.
        const attrs: SshAttrs = entry.attrs
        return [
          entry.filename,
          new IndexEntry({
            id: `${dirPrefix}${entry.filename}`,
            name: entry.filename,
            resourceType: isDirectoryAttrs(attrs) ? ResourceType.FOLDER : ResourceType.FILE,
            size: isFileAttrs(attrs) ? (attrs.size ?? null) : null,
            remoteTime: attrs.mtime !== undefined ? epochToIso(attrs.mtime) : '',
          }),
        ]
      }),
    )
  }
  return names
}
