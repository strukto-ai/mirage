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

import { mountedPath, rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eacces, eexist, enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isFailure, isNoSuchFile, isPermissionDenied, joinRoot, sftpCall } from './utils.ts'

async function statRemote(sftp: SFTPWrapper, remote: string): Promise<Stats | null> {
  return new Promise<Stats | null>((resolveFn) => {
    sftp.lstat(remote, (err, stats) => {
      if (err) resolveFn(null)
      else resolveFn(stats)
    })
  })
}

export async function mkdir(accessor: SSHAccessor, p: PathSpec, recursive = false): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = rawPathOf(p)
  const root = accessor.config.root ?? '/'
  const remote = joinRoot(root, virtual)
  if (!recursive) {
    try {
      await sftpCall((done) => {
        sftp.mkdir(remote, done)
      })
    } catch (err) {
      if (isNoSuchFile(err)) throw enoent(p)
      // OpenSSH answers an existing target with SFTP 3's one generic
      // refusal; only a stat can tell it was EEXIST.
      if (isFailure(err) && (await statRemote(sftp, remote)) !== null) throw eexist(p)
      throw err
    }
    return
  }
  // Whether a directory stands at `at`, past a server-side link to one: a
  // missing or unreadable name is not one and any other refusal is an error,
  // as asyncssh's isdir answers on Python.
  const isDir = async (at: string): Promise<boolean> => {
    try {
      return (
        await sftpCall<Stats>((done) => {
          sftp.stat(at, done)
        })
      ).isDirectory()
    } catch (err) {
      if (isNoSuchFile(err) || isPermissionDenied(err)) return false
      throw err
    }
  }
  const base = rstripSlash(root).length
  let cur = remote.startsWith('/') ? '/' : ''
  for (const part of remote.split('/').filter(Boolean)) {
    const step = cur === '' || cur === '/' ? cur + part : `${cur}/${part}`
    cur = step
    if (await isDir(step)) continue
    try {
      await sftpCall((done) => {
        sftp.mkdir(step, done)
      })
    } catch (err) {
      if (await isDir(step)) continue
      // The step -p tripped on, in the kernel's words: a name in the way is
      // EEXIST at the operand and ENOTDIR above it. A step at or above the
      // configured root names the mount root.
      const named = mountedPath(p, step.slice(base) || '/')
      if (isPermissionDenied(err)) throw eacces(named)
      if (isNoSuchFile(err)) throw enoent(named)
      if (isFailure(err) && (await statRemote(sftp, step)) !== null) {
        throw step === remote ? eexist(named) : enotdir(named)
      }
      throw err
    }
  }
}
