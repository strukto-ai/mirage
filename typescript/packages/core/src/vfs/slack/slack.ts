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

import { type ByteSource } from '../../io/types.ts'
import type { SlackAccessor } from '../../accessor/slack.ts'
import {
  follow as slackFollow,
  readMany as slackReadMany,
  readRange as slackReadRange,
  readStream as slackReadStream,
} from '../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../core/slack/readdir.ts'
import { filesContaining as slackFilesContaining } from '../../core/slack/search.ts'
import { stat as slackStat } from '../../core/slack/stat.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

/**
 * Slack's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class SlackVFSBase extends BaseVFS<SlackAccessor> {
  override readonly readsRanges: boolean = true
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry', 'parent'],
    follow: ['entry', 'parent'],
    readMany: ['entry', 'parent'],
    stat: ['entry', 'parent'],
  } as const
  // Slack search names channel and DM days; users and file blobs are read as
  // usual.
  override readonly searchable: readonly string[] = [
    'channels/*/*/chat.jsonl',
    'dms/*/*/chat.jsonl',
  ]

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return slackReaddir(this.accessor, path, handed?.entry)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
    signal?: AbortSignal,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    const entry = handed?.entry ?? null
    const parent = handed?.parent ?? null
    if (offset === 0 && size === null)
      return slackReadStream(this.accessor, path, handed?.entry, handed?.parent, signal)
    return slackReadRange(
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
    handed?: readonly Handed[],
  ): Promise<Map<string, Uint8Array>> {
    return slackReadMany(this.accessor, paths, limit, handed)
  }

  override follow(
    path: PathSpec,
    n: number,
    interval: number,
    handed?: Handed,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return slackFollow(this.accessor, path, n, interval, handed?.entry, handed?.parent)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return slackStat(this.accessor, path, handed?.entry, handed?.parent)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (
      !opts.wholeWord ||
      this.walkLimit < 0 ||
      !(this.accessor.transport.searchAvailable?.() ?? true)
    )
      return Promise.resolve(null)
    return slackFilesContaining(this.accessor, text, [path])
  }
}
