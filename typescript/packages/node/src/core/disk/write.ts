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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { chmod, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function write(accessor: DiskAccessor, p: PathSpec, data: Uint8Array): Promise<void> {
  const timer = startOp()
  const full = await resolveInside(accessor.root, p)
  // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent
  // rather than building the chain, and the store-backed backends refuse
  // the same way. Only the virtual path may reach a stderr line.
  try {
    await writeFile(full, data)
  } catch (err) {
    throw diskError(err, p)
  }
  record('write', p.virtual, VFSName.DISK, data.byteLength, timer)
}

export async function writeStream(
  accessor: DiskAccessor,
  p: PathSpec,
  data: ByteSource,
  append = false,
  signal?: AbortSignal,
  atomic = false,
): Promise<void> {
  const timer = startOp()
  const full = await resolveInside(accessor.root, p)
  let size = 0
  let staged: string | null = null
  let reading = false
  try {
    signal?.throwIfAborted()
    let mode: number | undefined
    if (atomic) {
      try {
        mode = (await stat(full)).mode & 0o7777
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
      staged = await mkdtemp(join(dirname(full), '.mirage-'))
    }
    const target = staged === null ? full : join(staged, 'content')
    const file = await open(target, append ? 'a' : 'w')
    try {
      const source = chunks(data, signal)
      try {
        for (;;) {
          reading = true
          const next = await source.next()
          reading = false
          if (next.done) break
          await file.writeFile(next.value)
          size += next.value.byteLength
        }
      } finally {
        await source.return?.()
      }
    } finally {
      await file.close()
    }
    if (staged !== null) {
      if (mode !== undefined) await chmod(target, mode)
      await rename(target, full)
    }
  } catch (err) {
    if (reading) throw err
    throw diskError(err, p)
  } finally {
    if (staged !== null) await rm(staged, { recursive: true, force: true })
  }
  record(append ? 'append' : 'write', p.virtual, VFSName.DISK, size, timer)
}
