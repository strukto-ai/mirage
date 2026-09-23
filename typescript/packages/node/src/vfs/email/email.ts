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

import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { EmailAccessor } from '../../accessor/email.ts'
import { EMAIL_COMMANDS } from '../../commands/builtin/email/index.ts'
import { read as emailRead } from '../../core/email/read.ts'
import { readdir as emailReaddir } from '../../core/email/readdir.ts'
import { stat as emailStat } from '../../core/email/stat.ts'
import { EMAIL_OPS } from '../../ops/email/index.ts'
import {
  redactEmailConfig,
  type EmailConfig,
  type EmailConfigRedacted,
} from '../../core/email/config.ts'
import { EMAIL_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(emailReaddir)

export interface EmailVFSState {
  type: string
  config: EmailConfigRedacted
}

export class EmailVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.EMAIL
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .email.json is rendered at
  // readdir from the full message source the listing already fetches, and an
  // attachment's size is its decoded payload length.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = EMAIL_PROMPT
  readonly config: EmailConfig
  readonly accessor: EmailAccessor

  constructor(config: EmailConfig) {
    super()
    this.config = config
    this.accessor = new EmailAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  commands(): readonly RegisteredCommand[] {
    return EMAIL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return EMAIL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return emailRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return emailReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return emailStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.vfsPath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  vfsPath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<EmailVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactEmailConfig(this.config),
    })
  }

  override loadState(_state: EmailVFSState): Promise<void> {
    return Promise.resolve()
  }
}
