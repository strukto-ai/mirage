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

import { invalidateAfterUnlink } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/utils/errors'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isDirectoryAttrs, isFailure, isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

export async function unlink(accessor: SSHAccessor, p: PathSpec): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  try {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.unlink(remote, (err) => {
        if (err) rejectFn(err)
        else resolveFn()
      })
    })
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    // OpenSSH answers a directory with SFTP 3's one generic refusal;
    // Linux's unlink(2) says EISDIR.
    if (isFailure(err)) {
      const isDir = await new Promise<boolean>((resolveFn) => {
        sftp.stat(remote, (statErr, attrs) => {
          resolveFn(statErr ? false : isDirectoryAttrs(attrs))
        })
      })
      if (isDir) throw eisdir(p)
    }
    throw err
  }
  await invalidateAfterUnlink(p)
}
