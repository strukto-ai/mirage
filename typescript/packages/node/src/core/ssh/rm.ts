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

import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { invalidateSubtree } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isDirectoryAttrs, isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

async function statRemote(sftp: SFTPWrapper, remote: string): Promise<Stats> {
  return new Promise<Stats>((resolveFn, rejectFn) => {
    sftp.lstat(remote, (err, stats) => {
      if (err !== undefined) rejectFn(err)
      else resolveFn(stats)
    })
  })
}

async function readdirRemote(sftp: SFTPWrapper, remote: string): Promise<FileEntryWithStats[]> {
  return new Promise<FileEntryWithStats[]>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, list) => {
      if (err !== undefined) rejectFn(err)
      else resolveFn(list)
    })
  })
}

async function unlinkRemote(sftp: SFTPWrapper, remote: string): Promise<void> {
  return new Promise<void>((resolveFn, rejectFn) => {
    sftp.unlink(remote, (err) => {
      if (err) rejectFn(err)
      else resolveFn()
    })
  })
}

async function rmdirRemote(sftp: SFTPWrapper, remote: string): Promise<void> {
  return new Promise<void>((resolveFn, rejectFn) => {
    sftp.rmdir(remote, (err) => {
      if (err) rejectFn(err)
      else resolveFn()
    })
  })
}

async function rmRecurse(sftp: SFTPWrapper, remote: string): Promise<void> {
  const stats = await statRemote(sftp, remote)
  if (isDirectoryAttrs(stats)) {
    const entries = await readdirRemote(sftp, remote)
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue
      const child = remote === '/' ? `/${entry.filename}` : `${remote}/${entry.filename}`
      await rmRecurse(sftp, child)
    }
    await rmdirRemote(sftp, remote)
    return
  }
  await unlinkRemote(sftp, remote)
}

export async function rmR(accessor: SSHAccessor, p: PathSpec): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  try {
    await rmRecurse(sftp, remote)
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    throw err
  }
  await invalidateSubtree(p)
}
