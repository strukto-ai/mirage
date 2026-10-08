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

import { BaseVFS, type VFSStateBase } from '../base.ts'
import { HistoryAccessor } from '../../accessor/history.ts'

import type { Observer } from '../../observe/observer.ts'

import { VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import type { FindOptions } from '../base.ts'
import { readdir as historyReaddir } from '../../core/history/readdir.ts'
import { read as historyRead } from '../../core/history/read.ts'
import { stat as historyStat } from '../../core/history/stat.ts'
import { find } from '../../core/history/find.ts'

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

  override readdir(path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return historyReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await historyRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return historyStat(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return find(this.accessor, path, options)
  }

  /** The view owns nothing, so its type alone rebuilds it. */
  override getState(): VFSStateBase {
    return { type: this.name }
  }
}
