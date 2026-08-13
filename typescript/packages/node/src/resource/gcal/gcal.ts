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
  GCAL_COMMANDS,
  GCAL_PROMPT,
  GCAL_OPS,
  GCAL_WRITE_PROMPT,
  GCalAccessor,
  PathSpec,
  ResourceName,
  TokenManager,
  gcalRead,
  gcalReaddir,
  makeResolveGlob,
  gcalStat,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactGCalConfig, type GCalConfig, type GCalConfigRedacted } from './config.ts'

const gcalResolveGlob = makeResolveGlob(gcalReaddir)

export interface GCalResourceState {
  type: string
  config: GCalConfigRedacted
}

export class GCalResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GCAL
  readonly cachesReads: boolean = true
  // Shorter than the other Google mounts: a calendar is edited by other
  // people and a day-long index would keep serving a schedule that has
  // already moved.
  override readonly indexTtl: number = 300
  readonly prompt: string = GCAL_PROMPT
  readonly writePrompt: string = GCAL_WRITE_PROMPT
  readonly config: GCalConfig
  readonly accessor: GCalAccessor

  constructor(config: GCalConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({ tokenManager: tm, config })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GCAL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GCAL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gcalRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gcalReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gcalStat(this.accessor, p, this.index)
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
    return gcalResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GCalResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGCalConfig(this.config),
    })
  }

  loadState(_state: GCalResourceState): Promise<void> {
    return Promise.resolve()
  }
}
