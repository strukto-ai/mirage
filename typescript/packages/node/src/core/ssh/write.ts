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
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot, openForWrite, stripPrefix } from './utils.ts'

export async function write(accessor: SSHAccessor, p: PathSpec, data: Uint8Array): Promise<void> {
  const timer = startOp()
  const sftp = await accessor.sftp()
  const key = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', key)
  const handle = await openForWrite(sftp, remote, p, true)
  try {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.write(handle, Buffer.from(data), 0, data.byteLength, 0, (err) => {
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
  record('write', p.virtual, VFSName.SSH, data.byteLength, timer)
  await invalidateAfterWrite(p)
}
