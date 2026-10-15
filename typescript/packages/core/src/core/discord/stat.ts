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

import { dayStat, guardDay } from '../time_range.ts'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { detectScope } from './scope.ts'

/**
 * Stat chat.jsonl, which survives a sealed day.
 *
 * A day whose history could not be listed (403/404/429) seals an empty date
 * dir; the file still stats, with the size left unknown.
 */
async function statChat(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null,
): Promise<FileStat> {
  await guardDay(accessor, match, path.virtual)
  if (entry !== null) return entry
  if (parent === null) throw enoent(path)
  return new FileStat({ name: 'chat.jsonl', type: FileType.FILE, content: ContentType.TEXT })
}

// A files directory or a blob is what its day's listing names, which no day
// outside the mount's scope has; a day and its chat.jsonl exist beyond what
// is listed.
export const stat = makeStat<DiscordAccessor>(detectScope, {
  overrides: {
    day: dayStat(guardDay),
    messages: statChat,
  },
})
