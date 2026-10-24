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

export const VFS_MD = `{prefix}
  channels/
    <channel-name>__<channel-id>/
      <yyyy-mm-dd>/
        chat.jsonl                # messages for that date
        files/                    # attachments shared that day (may be empty)
          <name>__<F-id>.<ext>    # cat to download bytes
  dms/
    <user-name>__<dm-id>/
      <yyyy-mm-dd>/
        chat.jsonl
        files/
          <name>__<F-id>.<ext>
  users/
    <username>__<user-id>.json    # user profile
  Naming: channel/DM/user directory names are \`<display-name>__<id>\`.
  The display name keeps the original spelling from Slack; only \`/\` is
  replaced with \`∕\` (U+2215) so paths don't break. Quote names
  containing spaces in shell commands. Always ls the parent dir first
  to discover exact entry names (they include IDs).
  Without time bounds, bare channel listings show the latest 90 days
  ending at the newest message. Date globs can discover earlier days.
  With start_time/end_time, listings cover that scope; messages and their
  attachments outside it are absent, including through direct paths.
  Users and channel metadata remain available as context.
  On a time-scoped mount grep and rg see only the in-scope files.
  Messages are JSONL; use jq to extract fields like .text, .user, .ts, .files.
  .user is a user ID (U…), not a username; resolve it through
  users/<username>__<user-id>.json and filter messages by the ID.
  Unless walk_limit is -1, grep -rw and rg -w read only the channel
  and DM days Slack search names; attachments under files/ are always read.`

/**
 * Slack's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class SlackVFSBase extends BaseVFS<SlackAccessor> {
  override readonly readsRanges: boolean = true
  override readonly wholeWordSearch: boolean = true
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

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.fullScanLimit < 0) return false
    return super.supports(name)
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
