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
  GDOCS_COMMANDS,
  GDOCS_PROMPT,
  GDOCS_VFS_OPS,
  GDOCS_WRITE_PROMPT,
  GDocsAccessor,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  TokenManager,
  gdocsRead,
  gdocsReaddir,
  gdocsResolveGlob,
  gdocsStat,
} from '@struktoai/mirage-core'
import { redactGDocsConfig, type GDocsConfig, type GDocsConfigRedacted } from './config.ts'

export interface GDocsResourceState {
  type: string
  needsOverride: boolean
  redactedFields: readonly string[]
  config: GDocsConfigRedacted
}

export class GDocsResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GDOCS
  readonly isRemote: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GDOCS_PROMPT
  readonly writePrompt: string = GDOCS_WRITE_PROMPT
  readonly config: GDocsConfig
  readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    })
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GDOCS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDOCS_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gdocsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gdocsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gdocsStat(this.accessor, p, this.index)
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
    return gdocsResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GDocsResourceState> {
    return Promise.resolve({
      type: this.kind,
      needsOverride: true,
      redactedFields: ['clientSecret', 'refreshToken'],
      config: redactGDocsConfig(this.config),
    })
  }

  loadState(_state: GDocsResourceState): Promise<void> {
    return Promise.resolve()
  }
}
