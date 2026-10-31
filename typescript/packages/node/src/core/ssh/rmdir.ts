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
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotempty } from '@struktoai/mirage-core/errors/fs'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { holdsEntries, isFailure, isNoSuchFile, joinRoot } from './utils.ts'

// SFTP 3 has one generic code for a not-empty refusal (SSH_FX_FAILURE),
// which is what ssh2 always speaks, so one listing probe decides
// instead of a blind translation: only a directory that still shows
// entries converts to ENOTEMPTY, anything else keeps the server's own
// answer. Without the conversion the hidden-remnant guard never fires
// on ssh (it keys on the errno), and the raw SFTP failure leaks.
export async function rmdir(accessor: SSHAccessor, p: PathSpec): Promise<void> {
  const sftp = await accessor.sftp()
  const virtual = rawPathOf(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  try {
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.rmdir(remote, (err) => {
        if (!err) {
          resolveFn()
          return
        }
        if (isNoSuchFile(err)) rejectFn(enoent(p))
        else rejectFn(err)
      })
    })
  } catch (err) {
    if (isFailure(err) && (await holdsEntries(sftp, remote))) {
      throw enotempty(p)
    }
    throw err
  }
}
