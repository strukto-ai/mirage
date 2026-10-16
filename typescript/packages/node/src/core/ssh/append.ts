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

import { chunks } from '@struktoai/mirage-core/io/cooperative'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot, openForWrite, stripPrefix } from './utils.ts'

export async function appendBytes(
  accessor: SSHAccessor,
  p: PathSpec,
  data: Uint8Array,
): Promise<void> {
  await appendStream(accessor, p, data)
}

export async function appendStream(
  accessor: SSHAccessor,
  p: PathSpec,
  data: ByteSource,
  signal?: AbortSignal,
): Promise<void> {
  const timer = startOp()
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const handle = await openForWrite(sftp, remote, p, 'a')
  let size = 0
  try {
    for await (const chunk of chunks(data, signal)) {
      await new Promise<void>((resolveFn, rejectFn) => {
        sftp.write(handle, Buffer.from(chunk), 0, chunk.byteLength, 0, (err) => {
          if (err) rejectFn(err)
          else resolveFn()
        })
      })
      size += chunk.length
    }
  } finally {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.close(handle, (err) => {
        if (err) rejectFn(err)
        else resolveFn()
      })
    })
  }
  record('append', p.virtual, VFSName.SSH, size, timer)
}
