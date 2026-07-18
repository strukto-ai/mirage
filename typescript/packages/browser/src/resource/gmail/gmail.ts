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

import { mountKey, mountPrefixOf } from '@struktoai/mirage-core'
import {
  type FileStat,
  GMAIL_COMMANDS,
  GMAIL_PROMPT,
  GMAIL_WRITE_PROMPT,
  GMAIL_OPS,
  GmailAccessor,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  TokenManager,
  gmailRead,
  gmailReaddir,
  makeResolveGlob,
  gmailStat,
} from '@struktoai/mirage-core'
import { redactGmailConfig, type GmailConfig, type GmailConfigRedacted } from './config.ts'

const gmailResolveGlob = makeResolveGlob(gmailReaddir)

export interface GmailResourceState {
  type: string
  config: GmailConfigRedacted
}

export class GmailResource implements Resource {
  readonly kind: string = ResourceName.GMAIL
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GMAIL_PROMPT
  readonly writePrompt: string = GMAIL_WRITE_PROMPT
  readonly config: GmailConfig
  readonly accessor: GmailAccessor
  readonly index: IndexCacheStore

  constructor(config: GmailConfig) {
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
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
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  resourcePath: mountKey(p.virtual, prefix),
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
