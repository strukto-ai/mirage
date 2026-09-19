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

import { RegisteredCommand } from '../../commands/config.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'

/**
 * Rebind S3-registered ops to an S3-compatible alias kind (gcs, r2,
 * minio, wasabi, ...) so dispatch finds them under the alias VFS.
 */
export function remapOpsVfs(ops: readonly RegisteredOp[], to: string): RegisteredOp[] {
  return ops.map((op) => (op.vfs === VFSName.S3 ? { ...op, vfs: to } : op))
}

/**
 * Same as `remapOpsVfs` but for registered commands.
 */
export function remapCommandsVfs(
  commands: readonly RegisteredCommand[],
  to: string,
): RegisteredCommand[] {
  return commands.map((cmd) => {
    if (cmd.vfs !== VFSName.S3) return cmd
    return new RegisteredCommand({
      name: cmd.name,
      spec: cmd.spec,
      vfs: to,
      filetype: cmd.filetype,
      fn: cmd.fn,
      provisionFn: cmd.provisionFn,
      aggregate: cmd.aggregate,
      src: cmd.src,
      dst: cmd.dst,
      write: cmd.write,
      read: cmd.read,
      limit: cmd.limit,
    })
  })
}
