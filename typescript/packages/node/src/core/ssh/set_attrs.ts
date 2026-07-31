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

import type { PathSpec } from '@struktoai/mirage-core'
import { enoent } from '@struktoai/mirage-core'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

function sftpStat(sftp: SFTPWrapper, remote: string, p: PathSpec): Promise<Stats> {
  return new Promise((resolveFn, rejectFn) => {
    sftp.stat(remote, (err, stats) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) rejectFn(enoent(p))
        else rejectFn(err)
        return
      }
      resolveFn(stats)
    })
  })
}

function sftpChmod(sftp: SFTPWrapper, remote: string, mode: number): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    sftp.chmod(remote, mode, (err) => {
      if (err !== undefined && err !== null) rejectFn(err)
      else resolveFn()
    })
  })
}

function sftpUtimes(
  sftp: SFTPWrapper,
  remote: string,
  atime: number,
  mtime: number,
): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    sftp.utimes(remote, atime, mtime, (err) => {
      if (err !== undefined && err !== null) rejectFn(err)
      else resolveFn()
    })
  })
}

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
  fields: SetAttrsFields,
): Promise<Record<string, number | string>> {
  const sftp = await accessor.sftp()
  const remote = joinRoot(accessor.config.root ?? '/', stripPrefix(path))
  const st = await sftpStat(sftp, remote, path)
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) {
    const keep = st.isDirectory() ? 0o700 : 0o600
    await sftpChmod(sftp, remote, fields.mode | keep)
    if ((fields.mode | keep) !== fields.mode) residual.mode = fields.mode
  }
  if (fields.uid !== undefined) residual.uid = fields.uid
  if (fields.gid !== undefined) residual.gid = fields.gid
  if (fields.atime !== undefined || fields.mtime !== undefined) {
    const newAtime =
      fields.atime !== undefined ? Math.floor(Date.parse(fields.atime) / 1000) : st.atime
    const newMtime =
      fields.mtime !== undefined ? Math.floor(Date.parse(fields.mtime) / 1000) : st.mtime
    await sftpUtimes(sftp, remote, newAtime, newMtime)
  }
  return residual
}
