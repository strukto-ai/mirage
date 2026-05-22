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

import {
  BaseResource,
  type FileStat,
  GMAIL_COMMANDS,
  GMAIL_PROMPT,
  GMAIL_WRITE_PROMPT,
  GMAIL_VFS_OPS,
  GmailAccessor,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  TokenManager,
  gmailRead,
  gmailReaddir,
  gmailResolveGlob,
  gmailStat,
} from '@struktoai/mirage-core'
import { redactGmailConfig, type GmailConfig, type GmailConfigRedacted } from './config.ts'

export interface GmailResourceState {
  type: string
  config: GmailConfigRedacted
}

export class GmailResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GMAIL
  readonly isRemote: boolean = true
  readonly indexTtl: number = 86_400
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

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GMAIL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GMAIL_VFS_OPS
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

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.original)
    return lookup.entry?.remoteTime ?? null
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            p.prefix !== ''
              ? p
              : new PathSpec({
                  original: p.original,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  prefix,
                }),
          )
        : paths
    return gmailResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GmailResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGmailConfig(this.config),
    })
  }

  loadState(_state: GmailResourceState): Promise<void> {
    return Promise.resolve()
  }
}
