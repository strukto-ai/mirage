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

import { Accessor } from '@struktoai/mirage-core/accessor/index'
import type { StorageUsage } from '@struktoai/mirage-core/vfs/capacity'

export class DiskAccessor extends Accessor {
  readonly root: string
  // Whether a listing is stored with its folder's version
  // (core/disk/listing_version.ts).
  readonly folderVersions: boolean
  /** The root's capacity and counted bytes, null when uncapped. */
  usage: StorageUsage | null = null

  constructor(root: string, folderVersions = true) {
    super()
    this.root = root
    this.folderVersions = folderVersions
  }

  /** Drop its own answers, its count of the root's bytes among them: a write
   * past the dispatcher went uncounted. Mirrors Python's. */
  override forget(): void {
    super.forget?.()
    this.usage?.stale()
  }
}
