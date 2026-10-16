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

import { randomUUID } from 'node:crypto'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, openForWrite, stripPrefix } from './utils.ts'

export async function write(accessor: SSHAccessor, p: PathSpec, data: Uint8Array): Promise<void> {
  await writeStream(accessor, p, data)
}

export async function writeStream(
  accessor: SSHAccessor,
  p: PathSpec,
  data: ByteSource,
  signal?: AbortSignal,
  atomic = false,
): Promise<void> {
  const timer = startOp()
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', stripPrefix(p))
  const target = atomic ? remote + '.mirage-' + randomUUID() : remote
  let staged = false
  let size = 0
  try {
    const mode = atomic
      ? await new Promise<number | null>((resolve, reject) => {
          sftp.stat(remote, (error, attrs) => {
            if (error) {
              if (isNoSuchFile(error)) resolve(null)
              else reject(error)
            } else resolve(attrs.mode)
          })
        })
      : null
    const handle = await openForWrite(sftp, target, p, atomic ? 'wx' : 'w')
    staged = atomic
    try {
      for await (const part of chunks(data, signal)) {
        await new Promise<void>((resolve, reject) => {
          sftp.write(handle, Buffer.from(part), 0, part.length, size, (error) => {
            if (error) reject(error)
            else resolve()
          })
        })
        size += part.length
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        sftp.close(handle, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
    if (atomic) {
      signal?.throwIfAborted()
      if (mode !== null)
        await new Promise<void>((resolve, reject) => {
          sftp.chmod(target, mode & 0o7777, (error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      await new Promise<void>((resolve, reject) => {
        sftp.ext_openssh_rename(target, remote, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      staged = false
    }
  } finally {
    await closeQuietly(data)
    if (staged)
      await new Promise<void>((resolve) => {
        sftp.unlink(target, (error) => {
          if (error) console.debug(`Could not remove staged ${target}`, error)
          resolve()
        })
      })
  }
  record('write', p.virtual, VFSName.SSH, size, timer)
}
