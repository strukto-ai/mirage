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
  GDOCS_COMMANDS,
  GDOCS_PROMPT,
  GDOCS_OPS,
  GDOCS_WRITE_PROMPT,
  GDocsAccessor,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  TokenManager,
  gdocsRead,
  gdocsReaddir,
  makeResolveGlob,
  gdocsStat,
} from '@struktoai/mirage-core'
import { redactGDocsConfig, type GDocsConfig, type GDocsConfigRedacted } from './config.ts'

const gdocsResolveGlob = makeResolveGlob(gdocsReaddir)

export interface GDocsResourceState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsResource implements Resource {
  readonly kind: string = ResourceName.GDOCS
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GDOCS_PROMPT
  readonly writePrompt: string = GDOCS_WRITE_PROMPT
  readonly config: GDocsConfig
  readonly accessor: GDocsAccessor
  readonly index: IndexCacheStore

  constructor(config: GDocsConfig) {
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      refreshToken: config.refreshToken,
      ...(config.refreshFn !== undefined ? { refreshFn: config.refreshFn } : {}),
      ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
    })
    this.accessor = new GDocsAccessor({ tokenManager: tm })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
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
    return GDOCS_OPS
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
    return gdocsResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GDocsResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDocsConfig(this.config),
    })
  }

  loadState(_state: GDocsResourceState): Promise<void> {
    return Promise.resolve()
  }
}
