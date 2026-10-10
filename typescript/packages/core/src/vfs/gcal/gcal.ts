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
import { GCalAccessor } from '../../accessor/gcal.ts'

import { bucketName, bucketStart } from '../../core/gcal/day.ts'
import { TokenManager } from '../../core/google/client.ts'

import { BUCKET_PROMPT, DAY_PROMPT, PROMPT, WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGCalConfig, type GCalConfig, type GCalConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as gcalReaddir } from '../../core/gcal/readdir.ts'
import { read as gcalRead } from '../../core/gcal/read.ts'
import { stat as gcalStat } from '../../core/gcal/stat.ts'
import { unlink as gcalUnlink } from '../../core/gcal/unlink.ts'

const EXAMPLE_DAY = '2026-08-11'

/** The prompt for a mount's tree, its examples named on that grid. */
function treePrompt(size: number): string {
  const layout = size === 1 ? DAY_PROMPT : BUCKET_PROMPT
  const bucket = bucketName(bucketStart(EXAMPLE_DAY, size), size)
  const day = size === 1 ? '' : `${EXAMPLE_DAY}_`
  return PROMPT.replaceAll('{layout}', layout)
    .replaceAll('{days}', String(size))
    .replaceAll('{bucket}', bucket)
    .replaceAll('{day}', day)
}

export interface GCalVFSState {
  type: string
  config: GCalConfigRedacted
}

export class GCalVFS extends BaseVFS {
  override readonly name: string = VFSName.GCAL
  override readonly cachesReads: boolean = true
  // Shorter than the other Google mounts: a calendar is edited by other
  // people and a day-long index would keep serving a schedule that has
  // already moved.
  override readonly indexTtl: number = 300
  override readonly prompt: string
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: GCalConfig
  override readonly accessor: GCalAccessor

  constructor(config: GCalConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({ tokenManager: tm, config })
    this.prompt = treePrompt(config.bucketDays) + this.accessor.timeRange.prompt()
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gcalReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gcalRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gcalStat(this.accessor, path, index)
  }

  override unlink(path: PathSpec, index?: IndexCacheStore): Promise<void> {
    return gcalUnlink(this.accessor, path, index)
  }

  override getState(): Promise<GCalVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGCalConfig(this.config),
    })
  }
}
