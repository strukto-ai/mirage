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

import { Accessor } from './base.ts'
import type { DatabricksVolumeConfig } from '../vfs/databricks_volume/config.ts'

export class DatabricksVolumeAccessor extends Accessor {
  readonly config: DatabricksVolumeConfig
  readonly host: string
  readonly token: string

  constructor(config: DatabricksVolumeConfig, host: string, token: string) {
    super()
    this.config = config
    let h = host
    while (h.endsWith('/')) h = h.slice(0, -1)
    this.host = h
    this.token = token
  }
}
