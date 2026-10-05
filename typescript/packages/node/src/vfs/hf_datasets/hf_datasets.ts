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

import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { VFSName } from '@struktoai/mirage-core/types'
import { HfDatasetsAccessor } from '../../accessor/hf_hub.ts'
import { assertHfRepoRef } from '../hf_buckets/config.ts'
import { HfHubVFS } from '../hf_hub/base.ts'
import {
  type HfDatasetsConfig,
  type HfDatasetsConfigRedacted,
  redactHfDatasetsConfig,
} from './config.ts'
import { PROMPT } from './prompt.ts'

export interface HfDatasetsVFSState {
  type: string
  config: HfDatasetsConfigRedacted
}

export class HfDatasetsVFS extends HfHubVFS {
  override readonly name: string = VFSName.HF_DATASETS
  readonly prompt: string = PROMPT
  readonly config: HfDatasetsConfig
  readonly accessor: HfDatasetsAccessor

  constructor(config: HfDatasetsConfig) {
    super()
    assertHfRepoRef(config.repoId, 'repo_id')
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: HfDatasetsConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new HfDatasetsAccessor(this.config)
  }

  getState(): Promise<HfDatasetsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactHfDatasetsConfig(this.config),
    })
  }
}
