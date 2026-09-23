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

import { GmailAccessor } from '@struktoai/mirage-core/accessor/gmail'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { GMAIL_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gmail/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { read as gmailRead } from '@struktoai/mirage-core/core/gmail/read'
import { readdir as gmailReaddir } from '@struktoai/mirage-core/core/gmail/readdir'
import { stat as gmailStat } from '@struktoai/mirage-core/core/gmail/stat'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GMAIL_OPS } from '@struktoai/mirage-core/ops/gmail/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { GMAIL_PROMPT, GMAIL_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gmail/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactGmailConfig,
  type GmailConfig,
  type GmailConfigRedacted,
} from '@struktoai/mirage-core/vfs/gmail/config'

const gmailResolveGlob = makeResolveGlob(gmailReaddir)

export interface GmailVFSState {
  type: string
  config: GmailConfigRedacted
}

export class GmailVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GMAIL
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .gmail.json is rendered at
  // readdir from the full message the listing already fetched, and
  // attachments carry the decoded byte count.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GMAIL_PROMPT
  readonly writePrompt: string = GMAIL_WRITE_PROMPT
  readonly config: GmailConfig
  readonly accessor: GmailAccessor

  constructor(config: GmailConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GMAIL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GMAIL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gmailRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gmailReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gmailStat(this.accessor, p, this.index)
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
    return gmailResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGmailConfig(this.config),
    })
  }

  override loadState(_state: GmailVFSState): Promise<void> {
    return Promise.resolve()
  }
}
