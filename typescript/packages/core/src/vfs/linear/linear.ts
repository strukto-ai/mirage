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

import { BaseVFS } from '../base.ts'
import { LinearAccessor } from '../../accessor/linear.ts'

import { HttpLinearTransport } from '../../core/linear/client.ts'
import { redactLinearConfig } from '../../core/linear/config.ts'
import type { LinearConfig, LinearConfigRedacted } from '../../core/linear/config.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as linearReaddir } from '../../core/linear/readdir.ts'
import { read as linearRead } from '../../core/linear/read.ts'
import { stat as linearStat } from '../../core/linear/stat.ts'

export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BaseVFS {
  override readonly name: string = VFSName.LINEAR
  override readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: LinearConfig
  override readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[] } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return linearReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await linearRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return linearStat(this.accessor, path, index)
  }

  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLinearConfig(this.config),
    })
  }
}
