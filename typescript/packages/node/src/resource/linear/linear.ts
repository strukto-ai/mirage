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
  HttpLinearTransport,
  LINEAR_COMMANDS,
  LINEAR_PROMPT,
  LINEAR_VFS_OPS,
  LINEAR_WRITE_PROMPT,
  LinearAccessor,
  PathSpec,
  ResourceName,
  linearRead,
  linearReaddir,
  linearStat,
  mountKey,
  mountPrefixOf,
  resolveLinearGlob,
  type FileStat,
  type LinearReaddirFilter,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactLinearConfig, type LinearConfig, type LinearConfigRedacted } from './config.ts'

export interface LinearResourceState {
  type: string
  config: LinearConfigRedacted
}

export class LinearResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.LINEAR
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = LINEAR_PROMPT
  readonly writePrompt: string = LINEAR_WRITE_PROMPT
  readonly config: LinearConfig
  readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts))
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return LINEAR_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LINEAR_VFS_OPS
  }

  private filter(): LinearReaddirFilter {
    const out: LinearReaddirFilter = {}
    if (this.config.teamIds !== undefined) out.teamIds = this.config.teamIds
    return out
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return linearRead(this.accessor, p, this.index, this.filter())
  }

  readdir(p: PathSpec): Promise<string[]> {
    return linearReaddir(this.accessor, p, this.index, this.filter())
  }

  stat(p: PathSpec): Promise<FileStat> {
    return linearStat(this.accessor, p, this.index)
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
    return resolveLinearGlob(this.accessor, effective, this.index, this.filter())
  }

  getState(): Promise<LinearResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLinearConfig(this.config),
    })
  }

  loadState(_state: LinearResourceState): Promise<void> {
    return Promise.resolve()
  }
}
