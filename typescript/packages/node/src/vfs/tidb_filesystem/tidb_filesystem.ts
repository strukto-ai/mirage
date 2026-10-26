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

import { TiDBFilesystemVFSBase } from '@struktoai/mirage-core/vfs/tidb_filesystem/tidb_filesystem'
import { TiDBFilesystemAccessor } from '@struktoai/mirage-core/accessor/tidb_filesystem'

import { VFSName } from '@struktoai/mirage-core/types'

import {
  redactTiDBFilesystemConfig,
  type TiDBFilesystemConfig,
  type TiDBFilesystemConfigRedacted,
} from './config.ts'

export interface TiDBFilesystemVFSState {
  type: string
  config: TiDBFilesystemConfigRedacted
}

export class TiDBFilesystemVFS extends TiDBFilesystemVFSBase {
  override readonly name: string = VFSName.TIDB_FILESYSTEM
  override readonly cachesReads: boolean = true
  // A listing row and a HEAD both carry the byte count a download returns,
  // so no file's size waits on its content.
  override readonly sizesAlwaysKnown: boolean = true
  readonly config: TiDBFilesystemConfig
  override readonly accessor: TiDBFilesystemAccessor

  private constructor(config: TiDBFilesystemConfig, accessor: TiDBFilesystemAccessor) {
    super()
    this.config = config
    this.accessor = accessor
  }

  static create(config: TiDBFilesystemConfig): Promise<TiDBFilesystemVFS> {
    const accessor = new TiDBFilesystemAccessor(config)
    return Promise.resolve(new TiDBFilesystemVFS(config, accessor))
  }

  override getState(): Promise<TiDBFilesystemVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactTiDBFilesystemConfig(this.config),
    })
  }
}
