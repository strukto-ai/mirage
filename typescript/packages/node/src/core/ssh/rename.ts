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

import { invalidateSubtree } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

export async function rename(accessor: SSHAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const sftp = await accessor.sftp()
  const root = accessor.config.root ?? '/'
  const srcVirtual = stripPrefix(src)
  const dstVirtual = stripPrefix(dst)
  const remoteSrc = joinRoot(root, srcVirtual)
  const remoteDst = joinRoot(root, dstVirtual)
  // POSIX rename semantics (replace an existing destination); plain SFTP
  // rename refuses to overwrite, so prefer posix-rename@openssh.com. ssh2
  // throws synchronously when the server lacks the extension — only then
  // fall back to the plain rename.
  await new Promise<void>((resolveFn, rejectFn) => {
    const done = (err: unknown): void => {
      if (!err) resolveFn()
      else if (isNoSuchFile(err)) rejectFn(enoent(src))
      else rejectFn(err as Error)
    }
    try {
      sftp.ext_openssh_rename(remoteSrc, remoteDst, done)
    } catch {
      sftp.rename(remoteSrc, remoteDst, done)
    }
  })
  // Both sides are subtree evictions: a rename destroys the destination's
  // previous identity and relocates everything under the source, so a
  // listing or body cached below either name is now stale.
  await invalidateSubtree(dst)
  await invalidateSubtree(src)
}
