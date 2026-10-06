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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { readChunks } from './stream.ts'
import { isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * SFTP seeks, so a window costs the window rather than the whole file:
 * `start`/`end` bound the READs the stream issues. `end` is inclusive,
 * matching node's own `createReadStream`.
 *
 * Args:
 *   accessor: SSH accessor.
 *   p: the path to read.
 *   _index: unused; SFTP resolves the path itself.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: SSHAccessor,
  p: PathSpec,
  _index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const start = options?.offset ?? 0
  const size = options?.size ?? null
  const sftp = await accessor.sftp()
  const timer = startOp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  // ssh2's readFile stats the file and issues a single READ for the whole
  // size; servers that honor large reads (asyncssh) reply with a packet over
  // ssh2's 256 KiB cap, a fatal protocol error that strands the pending
  // callback. Stream in bounded chunks instead.
  const rs = sftp.createReadStream(remote, {
    start,
    ...(size === null ? {} : { end: start + size - 1 }),
  })
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
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  record('read', p.virtual, VFSName.SSH, total, timer)
  return out
}
