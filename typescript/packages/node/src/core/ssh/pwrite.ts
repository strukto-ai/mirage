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

import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot, openForWrite, sftpCall } from './utils.ts'

export async function pwrite(
  accessor: SSHAccessor,
  p: PathSpec,
  data: Uint8Array,
  offset: number,
): Promise<void> {
  const timer = startOp()
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', rawPathOf(p))
  const handle = await openForWrite(sftp, remote, p)
  try {
    await sftpCall((done) => {
      sftp.write(handle, Buffer.from(data), 0, data.byteLength, offset, done)
    })
  } finally {
    await sftpCall((done) => {
      sftp.close(handle, done)
    })
  }
  record('pwrite', p.virtual, VFSName.SSH, data.byteLength, timer)
}
