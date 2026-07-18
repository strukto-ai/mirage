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
  GSLIDES_COMMANDS,
  GSLIDES_PROMPT,
  GSLIDES_VFS_OPS,
  GSLIDES_WRITE_PROMPT,
  GSlidesAccessor,
  PathSpec,
  ResourceName,
  TokenManager,
  gslidesRead,
  gslidesReaddir,
  gslidesResolveGlob,
  gslidesStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'

export interface GSlidesResourceState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GSLIDES
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSLIDES_PROMPT
  readonly writePrompt: string = GSLIDES_WRITE_PROMPT
  readonly config: GSlidesConfig
  readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    })
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GSLIDES_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSLIDES_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gslidesRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gslidesReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, p, this.index)
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
    return gslidesResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GSlidesResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSlidesConfig(this.config),
    })
  }

  loadState(_state: GSlidesResourceState): Promise<void> {
    return Promise.resolve()
  }
}
