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
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { PathSpec } from '../../types.ts'
import { renderBashHistory } from './render.ts'

export const VIEW_NAME = '.bash_history'
export const VIEW_KEYS = ['', VIEW_NAME]

/** Render the GNU histfile from the recorder's command events. */
export async function read(accessor: HistoryAccessor, path: PathSpec): Promise<Uint8Array> {
  const key = path.mountPath
  if (!VIEW_KEYS.includes(stripSlash(key))) {
    throw enoent(path)
  }
  const events = await accessor.observer.commandEvents()
  return new TextEncoder().encode(renderBashHistory(events))
}
