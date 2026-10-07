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

import { BinAccessor } from '../../accessor/bin.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS, type VFSStateBase } from '../base.ts'
import type { FileStat, PathSpec, SetAttrFields } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as binReaddir } from '../../core/bin/readdir.ts'
import { read as binRead } from '../../core/bin/read.ts'
import { refuse } from '../../core/bin/refuse.ts'
import { stat as binStat } from '../../core/bin/stat.ts'

/**
 * Read-only view VFS backing the /usr/bin mount. Lists one executable
 * file per program the session can run, rendered from the workspace's
 * command lookup on every call; holds no storage of its own.
 */
export class BinViewVFS extends BaseVFS {
  override readonly name = VFSName.BIN
  override readonly cachesReads = false
  // A stub's size is its rendering: cheap, no network, never null.
  override readonly sizesAlwaysKnown = true
  override readonly accessor: BinAccessor

  constructor(programs: () => string[], note: (name: string) => string | null) {
    super()
    this.accessor = new BinAccessor(programs, note)
  }

  override readdir(path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return binReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await binRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return binStat(this.accessor, path)
  }

  // Every write is its own refusal instead of a missing function, which
  // would answer "Operation not supported" where a read-only directory says
  // EROFS.
  override write(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override append(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override pwrite(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override create(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override mkdir(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override unlink(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override rename(src: PathSpec): Promise<void> {
    return refuse(this.accessor, src)
  }

  override truncate(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override setattr(
    path: PathSpec,
    _fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return refuse(this.accessor, path)
  }

  /** The view owns nothing, so its type alone rebuilds it. */
  override getState(): VFSStateBase {
    return { type: this.name }
  }
}
