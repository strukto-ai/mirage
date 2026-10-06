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

import { invalidateAfterWrite } from '@struktoai/mirage-core/cache/context'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { enotsup } from '@struktoai/mirage-core/errors/fs'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot, openForWrite, stripPrefix } from './utils.ts'

export async function truncate(
  accessor: SSHAccessor,
  p: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  if (noCreate) throw enotsup('ssh', 'truncate --no-create', p)
  const timer = startOp()
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', stripPrefix(p))
  const handle = await openForWrite(sftp, remote, p)
  try {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.fsetstat(handle, { size: length }, (err) => {
        if (err) rejectFn(err)
        else resolveFn()
      })
    })
  } finally {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.close(handle, (err) => {
        if (err) rejectFn(err)
        else resolveFn()
      })
    })
  }
  record('truncate', p.virtual, VFSName.SSH, 0, timer)
  await invalidateAfterWrite(p)
}
