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
  GDRIVE_COMMANDS,
  GDRIVE_PROMPT,
  GDRIVE_VFS_OPS,
  GDriveAccessor,
  PathSpec,
  ResourceName,
  TokenManager,
  gdriveRead,
  gdriveReaddir,
  gdriveResolveGlob,
  gdriveStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactGDriveConfig, type GDriveConfig, type GDriveConfigRedacted } from './config.ts'

export interface GDriveResourceState {
  type: string
  config: GDriveConfigRedacted
}

export class GDriveResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GDRIVE
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GDRIVE_PROMPT
  readonly config: GDriveConfig
  readonly accessor: GDriveAccessor

  constructor(config: GDriveConfig) {
    super()
    this.config = config
    const tm = new TokenManager({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    })
    this.accessor = new GDriveAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GDRIVE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDRIVE_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gdriveRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gdriveReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gdriveStat(this.accessor, p, this.index)
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
    return gdriveResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GDriveResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDriveConfig(this.config),
    })
  }

  loadState(_state: GDriveResourceState): Promise<void> {
    return Promise.resolve()
  }
}
