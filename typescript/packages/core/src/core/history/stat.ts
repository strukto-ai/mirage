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

import type { HistoryAccessor } from '../../accessor/history.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { msToRfc3339 } from '../../utils/dates.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { viewEvents } from './read.ts'
import { renderBashHistory } from './render.ts'

/** Stat the rendered histfile, sized to the current rendering and dated by
 * its last command. */
export async function stat(accessor: HistoryAccessor, path: PathSpec): Promise<FileStat> {
  const events = await viewEvents(accessor, path)
  const stamps = events.flatMap((e) => (typeof e.timestamp === 'number' ? [e.timestamp] : []))
  return new FileStat({
    name: '.bash_history',
    size: new TextEncoder().encode(renderBashHistory(events)).byteLength,
    modified:
      stamps.length > 0 ? msToRfc3339(stamps.reduce((a, b) => Math.max(a, b))) : accessor.made,
    type: FileType.FILE,
    content: contentTypeForPath('.bash_history'),
    nlink: 1,
  })
}
