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

import { DocumentAccessor } from '../../accessor/document.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { read } from '../../core/document/read.ts'
import { readdir } from '../../core/document/readdir.ts'
import { stat } from '../../core/document/stat.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'

export class DocumentVFS extends BaseVFS<DocumentAccessor> {
  globalView = false
  readonly sessions = new Map<string, number>()
  constructor(
    name: string,
    render: () => string,
    readonly kind: string,
  ) {
    super({
      name: 'document',
      accessor: new DocumentAccessor(name, render),
      sizesAlwaysKnown: true,
    })
  }

  override readdir(path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return readdir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await read(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return stat(this.accessor, path)
  }
}
