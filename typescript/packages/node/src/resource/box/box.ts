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
  BOX_COMMANDS,
  BOX_PROMPT,
  BOX_VFS_OPS,
  BaseResource,
  BoxAccessor,
  BoxTokenManager,
  PathSpec,
  ResourceName,
  boxRead,
  boxReaddir,
  boxResolveGlob,
  boxStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'

export interface BoxResourceState {
  type: string
  config: BoxConfigRedacted
}

export class BoxResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.BOX
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = BOX_PROMPT
  readonly config: BoxConfig
  readonly accessor: BoxAccessor

  constructor(config: BoxConfig) {
    super()
    this.config = config
    const tm = new BoxTokenManager({
      ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      ...(config.refreshToken !== undefined ? { refreshToken: config.refreshToken } : {}),
      ...(config.enterpriseId !== undefined ? { enterpriseId: config.enterpriseId } : {}),
      ...(config.accessToken !== undefined ? { accessToken: config.accessToken } : {}),
      ...(config.refreshFn !== undefined ? { refreshFn: config.refreshFn } : {}),
      ...(config.onRefreshTokenRotated !== undefined
        ? { onRefreshTokenRotated: config.onRefreshTokenRotated }
        : {}),
    })
    this.accessor = new BoxAccessor({ tokenManager: tm })
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
