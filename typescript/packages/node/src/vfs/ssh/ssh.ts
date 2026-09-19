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

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { SSH_OPS } from '../../ops/ssh/index.ts'
import { type SSHConfig, type SSHConfigRedacted, redactSshConfig } from './config.ts'
import { SSH_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/ssh/watch.ts'
export interface SSHVFSState {
  type: string
  config: SSHConfigRedacted
}

export class SSHVFS extends BaseVFS {
  override readonly name = VFSName.SSH
  override readonly cachesReads: boolean = true
  // SFTP stat/readdir report the remote inode's exact byte size for every
  // file; reads are the same raw bytes.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 60
  override readonly prompt = SSH_PROMPT
  readonly config: SSHConfig
  override readonly accessor: SSHAccessor
  constructor(config: SSHConfig) {
    super()
    this.config = config
    this.accessor = new SSHAccessor(config)
  }
  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  override ops(): readonly RegisteredOp[] {
    return SSH_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return SSH_COMMANDS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  override async getState(): Promise<SSHVFSState> {
    return {
      type: this.name,
      config: redactSshConfig(this.config),
    }
  }

  override loadState(_state: SSHVFSState): Promise<void> {
    return Promise.resolve()
  }
}
