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

import type { DiscordAccessor } from '../../accessor/discord.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import {
  read as discordRead,
  readRange as discordReadRange,
  readStream as discordReadStream,
} from '../../core/discord/read.ts'
import { readdir as discordReaddir } from '../../core/discord/readdir.ts'
import { stat as discordStat } from '../../core/discord/stat.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'

/**
 * Discord's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class DiscordVFSBase extends BaseVFS<DiscordAccessor> {
  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return discordReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return discordRead(this.accessor, path, index)
    return discordReadRange(
      this.accessor,
      path,
      index,
      size === null ? { offset } : { offset, size },
    )
  }

  override readStream(
    path: PathSpec,
    index?: IndexCacheStore,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    return discordReadStream(this.accessor, path, index, signal)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return discordStat(this.accessor, path, index)
  }
}
