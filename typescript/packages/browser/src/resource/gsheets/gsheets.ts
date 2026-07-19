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
  GSHEETS_COMMANDS,
  GSHEETS_PROMPT,
  GSHEETS_OPS,
  GSHEETS_WRITE_PROMPT,
  GSheetsAccessor,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  TokenManager,
  gsheetsRead,
  gsheetsReaddir,
  makeResolveGlob,
  gsheetsStat,
} from '@struktoai/mirage-core'
import { redactGSheetsConfig, type GSheetsConfig, type GSheetsConfigRedacted } from './config.ts'

const gsheetsResolveGlob = makeResolveGlob(gsheetsReaddir)

export interface GSheetsResourceState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsResource implements Resource {
  readonly kind: string = ResourceName.GSHEETS
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GSHEETS_PROMPT
  readonly writePrompt: string = GSHEETS_WRITE_PROMPT
  readonly config: GSheetsConfig
  readonly accessor: GSheetsAccessor
  readonly index: IndexCacheStore

  constructor(config: GSheetsConfig) {
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      refreshToken: config.refreshToken,
      ...(config.refreshFn !== undefined ? { refreshFn: config.refreshFn } : {}),
      ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
    })
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GSHEETS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSHEETS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gsheetsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gsheetsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gsheetsStat(this.accessor, p, this.index)
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
    return gsheetsResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GSheetsResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSheetsConfig(this.config),
    })
  }

  loadState(_state: GSheetsResourceState): Promise<void> {
    return Promise.resolve()
  }
}
