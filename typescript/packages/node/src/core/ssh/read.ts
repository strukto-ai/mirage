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
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { readChunks } from './stream.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

export async function read(accessor: SSHAccessor, p: PathSpec): Promise<Uint8Array> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  // ssh2's readFile stats the file and issues a single READ for the whole
  // size; servers that honor large reads (asyncssh) reply with a packet over
  // ssh2's 256 KiB cap, a fatal protocol error that strands the pending
  // callback. Stream in bounded chunks instead.
  const rs = sftp.createReadStream(remote)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const u8 of readChunks(rs)) {
      chunks.push(u8)
      total += u8.byteLength
    }
  } catch (err) {
    if (isNoSuchFile(err)) throw enoent(p)
    throw err
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
