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
import { liveSessions } from '../../context/session_context.ts'
import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { PathSpec } from '../../types.ts'
import { renderBashHistory } from './render.ts'

export const VIEW_NAME = '.bash_history'
export const VIEW_KEYS = ['', VIEW_NAME]

/** Render the GNU histfile from the recorder's command events.
 *
 * A session reads its own commands only, as `history` does: another
 * session's lines are its own business. With no session bound every
 * session's commands are shown; `ws.vfs` reads as the default session, and
 * the host reads them all through `ws.history()`. A session's own view
 * names the reader; without one, on the fallback storage every live
 * session must be the same one, so a concurrent session's commands never
 * show. */
export async function read(accessor: HistoryAccessor, path: PathSpec): Promise<Uint8Array> {
  const key = path.mountPath
  if (!VIEW_KEYS.includes(stripSlash(key))) {
    throw enoent(path)
  }
  let events = await accessor.observer.commandEvents()
  const live = new Set(
    accessor.session !== null
      ? [accessor.session]
      : liveSessions().map((session) => session.sessionId),
  )
  if (live.size > 0) {
    events = events.filter(
      (e) => live.size === 1 && typeof e.session === 'string' && live.has(e.session),
    )
  }
  return new TextEncoder().encode(renderBashHistory(events))
}
