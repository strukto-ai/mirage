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

import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot } from './utils.ts'

/**
 * The space of the filesystem the mount's root sits on, for df, from the
 * server's statvfs, counted the way df counts a disk. A server without the
 * statvfs extension is UNKNOWN. Mirrors Python's `capacity`.
 */
export async function capacity(accessor: SSHAccessor): Promise<CapacityResult> {
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', '')
  let st: Record<
    | 'f_bsize'
    | 'f_frsize'
    | 'f_blocks'
    | 'f_bfree'
    | 'f_bavail'
    | 'f_files'
    | 'f_ffree'
    | 'f_favail',
    number | bigint
  >
  try {
    st = await new Promise<typeof st>((resolveFn, rejectFn) => {
      sftp.ext_openssh_statvfs(remote, (err, info: typeof st) => {
        if (err !== undefined) rejectFn(err)
        else resolveFn(info)
      })
    })
  } catch (error) {
    console.debug(`ssh statvfs unanswered: ${String(error)}`)
    return { state: CapacityState.UNKNOWN }
  }
  const frsize = Number(st.f_frsize) || Number(st.f_bsize)
  const blocks = Number(st.f_blocks)
  const files = Number(st.f_files)
  return {
    state: CapacityState.QUOTA,
    total: blocks * frsize,
    used: (blocks - Number(st.f_bfree)) * frsize,
    available: Number(st.f_bavail) * frsize,
    inodes: files,
    inodesUsed: files - Number(st.f_ffree),
    inodesFree: Number(st.f_favail),
  }
}
