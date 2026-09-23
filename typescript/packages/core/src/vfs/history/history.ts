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

import { HistoryAccessor } from '../../accessor/history.ts'
import { HISTORY_COMMANDS } from '../../commands/builtin/history/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import type { Observer } from '../../observe/observer.ts'
import { HISTORY_OPS } from '../../ops/history/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'

export const HISTORY_PREFIX = '/.bash_history'

/**
 * Read-only view VFS backing the /.bash_history mount. Renders GNU
 * views from the workspace's hidden recorder on every read; holds no
 * storage of its own.
 */
export class HistoryViewVFS extends BaseVFS {
  override readonly name = VFSName.HISTORY
  override readonly cachesReads = false
  // The view renders from in-memory events, so stat() sizes it by
  // rendering: cheap, no network, and never null.
  override readonly sizesAlwaysKnown = true
  override readonly accessor: HistoryAccessor

  constructor(observer: Observer) {
    super()
    this.accessor = new HistoryAccessor(observer)
  }
  override ops(): readonly RegisteredOp[] {
    return HISTORY_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return HISTORY_COMMANDS
  }
}
