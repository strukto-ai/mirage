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
import { GSlidesAccessor } from '../../accessor/gslides.ts'

import { TokenManager } from '../../core/google/client.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as gslidesReaddir } from '../../core/gslides/readdir.ts'
import { read as gslidesRead } from '../../core/gslides/read.ts'
import { stat as gslidesStat } from '../../core/gslides/stat.ts'
import { unlink as gslidesUnlink } from '../../core/gslides/unlink.ts'

export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS {
  override readonly name: string = VFSName.GSLIDES
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: GSlidesConfig
  override readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  override readonly renderers: Readonly<Record<string, string>> = { '.gslide.json': 'readDeck' }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gslidesReaddir(this.accessor, path, index)
  }

  /** Render the file as the JSON its `.gslide.json` name holds. */
  async readDeck(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gslidesRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gslidesStat(this.accessor, path, index)
  }

  override unlink(path: PathSpec, index?: IndexCacheStore): Promise<void> {
    return gslidesUnlink(this.accessor, path, index)
  }

  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSlidesConfig(this.config),
    })
  }
}
