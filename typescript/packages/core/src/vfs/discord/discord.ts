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
import {
  follow as discordFollow,
  read as discordRead,
  readMany as discordReadMany,
  readRange as discordReadRange,
  readStream as discordReadStream,
} from '../../core/discord/read.ts'
import { readdir as discordReaddir } from '../../core/discord/readdir.ts'
import { stat as discordStat } from '../../core/discord/stat.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

/**
 * Discord's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class DiscordVFSBase extends BaseVFS<DiscordAccessor> {
  override readonly readsRanges: boolean = true
  override readonly listsStats: boolean = true
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry', 'parent'],
    readStream: ['entry', 'parent'],
    follow: ['entry', 'parent'],
    stat: ['entry', 'parent'],
  } as const

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return discordReaddir(this.accessor, path, handed?.entry)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const entry = handed?.entry ?? null
    const parent = handed?.parent ?? null
    if (offset === 0 && size === null) return discordRead(this.accessor, path, entry, parent)
    return discordReadRange(
      this.accessor,
      path,
      entry,
      parent,
      size === null ? { offset } : { offset, size },
    )
  }

  override readMany(
    paths: PathSpec[],
    limit: number,
    index?: IndexCacheStore,
  ): Promise<Map<string, Uint8Array>> {
    return discordReadMany(this.accessor, paths, limit, index)
  }

  override readStream(
    path: PathSpec,
    handed?: Handed,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    return discordReadStream(this.accessor, path, handed?.entry, handed?.parent, signal)
  }

  override follow(
    path: PathSpec,
    n: number,
    interval: number,
    handed?: Handed,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return discordFollow(this.accessor, path, n, interval, handed?.entry, handed?.parent)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return discordStat(this.accessor, path, handed?.entry, handed?.parent)
  }
}
