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
import type { PathSpec } from '@struktoai/mirage-core/types'
import { listingError } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isDirectoryAttrs, isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

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

export async function readdir(accessor: SSHAccessor, p: PathSpec): Promise<string[]> {
  const sftp = await accessor.sftp()
  const virtual =
    p.pattern !== null
      ? p.directory.slice(mountPrefixOf(p.virtual, p.vfsPath).length) || '/'
      : stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const list = await new Promise<FileEntryWithStats[] | null>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) resolveFn(null)
        else rejectFn(err)
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
  const base = `/${stripSlash(virtual)}`
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const mountPrefix = mountPrefixOf(p.virtual, p.vfsPath)
  const names: string[] = []
  for (const entry of list) {
    if (entry.filename === '.' || entry.filename === '..') continue
    names.push(`${mountPrefix}${dirPrefix}${entry.filename}`)
  }
  names.sort(compareCodePoints)
  return names
}
