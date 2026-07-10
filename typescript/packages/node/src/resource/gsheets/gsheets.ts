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
  GSHEETS_COMMANDS,
  GSHEETS_PROMPT,
  GSHEETS_VFS_OPS,
  GSHEETS_WRITE_PROMPT,
  GSheetsAccessor,
  PathSpec,
  ResourceName,
  TokenManager,
  gsheetsRead,
  gsheetsReaddir,
  gsheetsResolveGlob,
  gsheetsStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactGSheetsConfig, type GSheetsConfig, type GSheetsConfigRedacted } from './config.ts'

export interface GSheetsResourceState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GSHEETS
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSHEETS_PROMPT
  readonly writePrompt: string = GSHEETS_WRITE_PROMPT
  readonly config: GSheetsConfig
  readonly accessor: GSheetsAccessor

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    })
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
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
    return GSHEETS_VFS_OPS
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

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.virtual)
    return lookup.entry?.remoteTime ?? null
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
