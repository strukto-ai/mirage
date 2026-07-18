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
  BOX_COMMANDS,
  BOX_PROMPT,
  BOX_VFS_OPS,
  BoxAccessor,
  BoxTokenManager,
  type FileStat,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  boxRead,
  boxReaddir,
  makeResolveGlob,
  boxStat,
} from '@struktoai/mirage-core'
import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'

const boxResolveGlob = makeResolveGlob(boxReaddir)

export interface BoxResourceState {
  type: string
  config: BoxConfigRedacted
}

export class BoxResource implements Resource {
  readonly kind: string = ResourceName.BOX
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = BOX_PROMPT
  readonly config: BoxConfig
  readonly accessor: BoxAccessor
  readonly index: IndexCacheStore

  constructor(config: BoxConfig) {
    this.config = config
    const tm = new BoxTokenManager({
      ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      ...(config.refreshToken !== undefined ? { refreshToken: config.refreshToken } : {}),
      ...(config.accessToken !== undefined ? { accessToken: config.accessToken } : {}),
      ...(config.refreshFn !== undefined ? { refreshFn: config.refreshFn } : {}),
      ...(config.onRefreshTokenRotated !== undefined
        ? { onRefreshTokenRotated: config.onRefreshTokenRotated }
        : {}),
    })
    this.accessor = new BoxAccessor({ tokenManager: tm })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return BOX_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return BOX_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return boxRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return boxReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return boxStat(this.accessor, p, this.index)
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
    return boxResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<BoxResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactBoxConfig(this.config),
    })
  }

  loadState(_state: BoxResourceState): Promise<void> {
    return Promise.resolve()
  }
}
