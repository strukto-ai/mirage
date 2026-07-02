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
  DROPBOX_COMMANDS,
  DROPBOX_PROMPT,
  DROPBOX_VFS_OPS,
  DropboxAccessor,
  DropboxTokenManager,
  PathSpec,
  ResourceName,
  dropboxRead,
  dropboxReaddir,
  dropboxResolveGlob,
  dropboxStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactDropboxConfig, type DropboxConfig, type DropboxConfigRedacted } from './config.ts'

export interface DropboxResourceState {
  type: string
  config: DropboxConfigRedacted
}

export class DropboxResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.DROPBOX
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = DROPBOX_PROMPT
  readonly config: DropboxConfig
  readonly accessor: DropboxAccessor

  constructor(config: DropboxConfig) {
    super()
    this.config = config
    const tm = new DropboxTokenManager({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      ...(config.refreshFn !== undefined ? { refreshFn: config.refreshFn } : {}),
    })
    this.accessor = new DropboxAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return DROPBOX_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DROPBOX_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return dropboxRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return dropboxReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return dropboxStat(this.accessor, p, this.index)
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
    return dropboxResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<DropboxResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDropboxConfig(this.config),
    })
  }

  loadState(_state: DropboxResourceState): Promise<void> {
    return Promise.resolve()
  }
}
