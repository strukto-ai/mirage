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

import type { SlackAccessor } from '../../accessor/slack.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { DU_MAX_ENTRIES } from '../../core/slack/constants.ts'
import {
  read as slackRead,
  readRange as slackReadRange,
  readStream as slackReadStream,
} from '../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../core/slack/readdir.ts'
import { filesContaining as slackFilesContaining } from '../../core/slack/search.ts'
import { stat as slackStat } from '../../core/slack/stat.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'

/**
 * Slack's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class SlackVFSBase extends BaseVFS<SlackAccessor> {
  override readonly maxDuEntries: number | null = DU_MAX_ENTRIES
  override readonly readsRanges: boolean = true
  // Slack search names channel days; DMs, users and file blobs are read as
  // usual.
  override readonly searchable: readonly string[] = ['channels/*/*/chat.jsonl']

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return slackReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return slackRead(this.accessor, path, index)
    return slackReadRange(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override readStream(
    path: PathSpec,
    index?: IndexCacheStore,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    return slackReadStream(this.accessor, path, index, signal)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return slackStat(this.accessor, path, index)
  }

  override filesContaining(
    text: string,
    under: PathSpec[],
    opts: { wholeWord: boolean; ignoreCase: boolean },
    index?: IndexCacheStore,
  ): Promise<PathSpec[] | null> {
    if (
      !opts.wholeWord ||
      !this.accessor.contentSearch ||
      !(this.accessor.transport.searchAvailable?.() ?? true)
    )
      return Promise.resolve(null)
    return slackFilesContaining(this.accessor, text, under, index)
  }
}
