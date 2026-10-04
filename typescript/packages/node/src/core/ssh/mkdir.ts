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

import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eexist, enoent } from '@struktoai/mirage-core/utils/errors'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isFailure, isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

async function statRemote(sftp: SFTPWrapper, remote: string): Promise<Stats | null> {
  return new Promise<Stats | null>((resolveFn) => {
    sftp.lstat(remote, (err, stats) => {
      if (err) resolveFn(null)
      else resolveFn(stats)
    })
  })
}

async function mkdirOne(sftp: SFTPWrapper, remote: string, ignoreExisting: boolean): Promise<void> {
  return new Promise<void>((resolveFn, rejectFn) => {
    sftp.mkdir(remote, (err) => {
      if (!err) {
        resolveFn()
        return
      }
      if (ignoreExisting) {
        // ignore: dir already exists
        resolveFn()
        return
      }
      rejectFn(err)
    })
  })
}

export async function mkdir(accessor: SSHAccessor, p: PathSpec, recursive = false): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const root = accessor.config.root ?? '/'
  const remote = joinRoot(root, virtual)
  if (!recursive) {
    try {
      await mkdirOne(sftp, remote, false)
    } catch (err) {
      if (isNoSuchFile(err)) throw enoent(p)
      // OpenSSH answers an existing target with SFTP 3's one generic
      // refusal; only a stat can tell it was EEXIST.
      if (isFailure(err) && (await statRemote(sftp, remote)) !== null) throw eexist(p)
      throw err
    }
    await invalidateAfterWrite(p)
    return
  }
  const cleaned = stripSlash(virtual)
  if (cleaned.length === 0) return
  const parts = cleaned.split('/')
  let cur = ''
  for (const part of parts) {
    cur = cur === '' ? `/${part}` : `${cur}/${part}`
    const stepRemote = joinRoot(root, cur)
    const existing = await statRemote(sftp, stepRemote)
    if (existing?.isDirectory()) continue
    await mkdirOne(sftp, stepRemote, true)
  }
  await invalidateAfterWrite(p)
  await invalidateAncestors(p)
}
