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

import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { PathSpec, SetAttrFields } from '@struktoai/mirage-core/types'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, sftpCall } from './utils.ts'

// Write metadata fields (the write side of stat), mirroring disk. Applies
// natively what the remote inode can take and returns the residual: fields
// the caller must overlay elsewhere. Times always apply via SFTP utimes, so
// touch results live on the real file and out-of-band readers see them.
// `mode` is applied with owner access kept (`chmod 000` must not lock
// mirage's own SFTP session out of reads; mount mode does real access
// control), so clamped bits come back as residual. Ownership never applies
// (chown over SFTP needs privileges the login user does not have) and is
// always residual.
export async function setAttrs(
  accessor: SSHAccessor,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<Record<string, number | string>> {
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', rawPathOf(path))
  let st: Stats
  try {
    st = await sftpCall<Stats>((done) => {
      sftp.stat(remote, done)
    })
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(path)
    throw err
  }
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) {
    const mode = fields.mode | (st.isDirectory() ? 0o700 : 0o600)
    await sftpCall((done) => {
      sftp.chmod(remote, mode, done)
    })
    if (mode !== fields.mode) residual.mode = fields.mode
  }
  if (fields.uid !== undefined) residual.uid = fields.uid
  if (fields.gid !== undefined) residual.gid = fields.gid
  if (fields.atime !== undefined || fields.mtime !== undefined) {
    const newAtime =
      fields.atime !== undefined ? Math.floor(Date.parse(fields.atime) / 1000) : st.atime
    const newMtime =
      fields.mtime !== undefined ? Math.floor(Date.parse(fields.mtime) / 1000) : st.mtime
    await sftpCall((done) => {
      sftp.utimes(remote, newAtime, newMtime, done)
    })
  }
  return residual
}
