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

import type { FileEntryWithStats } from 'ssh2'
import type { PathSpec } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'
import { enoent, mountPrefixOf, stripSlash } from '@struktoai/mirage-core'

export async function readdir(accessor: SSHAccessor, p: PathSpec): Promise<string[]> {
  const sftp = await accessor.sftp()
  const virtual =
    p.pattern !== null
      ? p.directory.slice(mountPrefixOf(p.virtual, p.resourcePath).length) || '/'
      : stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const list = await new Promise<FileEntryWithStats[]>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) rejectFn(enoent(p))
        else rejectFn(err)
        return
      }
      resolveFn(entries)
    })
  })
  const base = `/${stripSlash(virtual)}`
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const mountPrefix = mountPrefixOf(p.virtual, p.resourcePath)
  const names: string[] = []
  for (const entry of list) {
    if (entry.filename === '.' || entry.filename === '..') continue
    names.push(`${mountPrefix}${dirPrefix}${entry.filename}`)
  }
  names.sort()
  return names
}
