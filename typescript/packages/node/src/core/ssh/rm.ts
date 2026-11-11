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

import { enoent, enotempty } from '@struktoai/mirage-core/errors/fs'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import {
  holdsEntries,
  isDirectoryAttrs,
  isFailure,
  isNoSuchFile,
  joinRoot,
  sftpCall,
} from './utils.ts'

async function rmRInner(sftp: SFTPWrapper, remote: string, root: PathSpec): Promise<void> {
  const stats = await sftpCall<Stats>((done) => {
    sftp.lstat(remote, done)
  })
  if (isDirectoryAttrs(stats)) {
    const entries = await sftpCall<FileEntryWithStats[]>((done) => {
      sftp.readdir(remote, done)
    })
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue
      const child = remote === '/' ? `/${entry.filename}` : `${remote}/${entry.filename}`
      await rmRInner(sftp, child, root)
    }
    try {
      await sftpCall((done) => {
        sftp.rmdir(remote, done)
      })
    } catch (err) {
      // A file written after the listing keeps the directory; SFTP 3 says
      // so with its one generic code, so a listing decides.
      if (isFailure(err) && (await holdsEntries(sftp, remote))) throw enotempty(root)
      throw err
    }
    return
  }
  await sftpCall((done) => {
    sftp.unlink(remote, done)
  })
}

export async function rmR(accessor: SSHAccessor, p: PathSpec): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = rawPathOf(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  try {
    await rmRInner(sftp, remote, p)
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    throw err
  }
}
