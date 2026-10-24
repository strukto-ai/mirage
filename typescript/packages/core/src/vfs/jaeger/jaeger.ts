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

import type { JaegerAccessor } from '../../accessor/jaeger.ts'
import { read as jaegerRead } from '../../core/jaeger/read.ts'
import { readdir as jaegerReaddir } from '../../core/jaeger/readdir.ts'
import { stat as jaegerStat } from '../../core/jaeger/stat.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

export const VFS_MD = `{prefix}
  services/
    <service-name>/
      operations.json
      traces/
        <trace-id>.json`

/**
 * Jaeger's functions over its accessor, which a host package builds
 * over its own transport.
 */
export class JaegerVFSBase extends BaseVFS<JaegerAccessor> {
  override readonly handed = {
    stat: ['entry'],
  } as const

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return jaegerReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await jaegerRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return jaegerStat(this.accessor, path, handed?.entry)
  }
}
