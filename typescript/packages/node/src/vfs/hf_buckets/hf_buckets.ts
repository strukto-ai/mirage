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
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfVFS } from './base.ts'
import {
  assertHfRepoId,
  type HfBucketsConfig,
  type HfBucketsConfigRedacted,
  redactHfBucketsConfig,
} from './config.ts'
import { HF_BUCKETS_PROMPT } from './prompt.ts'

export interface HfBucketsVFSState {
  type: string
  config: HfBucketsConfigRedacted
}

export class HfBucketsVFS extends HfVFS {
  readonly kind: string = VFSName.HF_BUCKETS
  readonly prompt: string = HF_BUCKETS_PROMPT
  readonly config: HfBucketsConfig
  readonly accessor: HfBucketsAccessor

  constructor(config: HfBucketsConfig) {
    super()
    assertHfRepoId(config.bucket, 'bucket')
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: HfBucketsConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new HfBucketsAccessor(this.config)
  }

  getState(): Promise<HfBucketsVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactHfBucketsConfig(this.config),
    })
  }
}
