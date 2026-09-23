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

import { VFSName } from '@struktoai/mirage-core/types'
import { S3AliasVFS, type S3AliasVFSState } from '../s3_alias.ts'
import {
  cephToS3Config,
  redactCephConfig,
  type CephConfig,
  type CephConfigRedacted,
} from './config.ts'
import { CEPH_BROWSER_PROMPT } from './prompt.ts'

export type CephVFSState = S3AliasVFSState<CephConfigRedacted>

export class CephVFS extends S3AliasVFS<CephConfig, CephConfigRedacted> {
  override readonly prompt: string = CEPH_BROWSER_PROMPT

  constructor(config: CephConfig) {
    super(VFSName.CEPH, config, cephToS3Config(config), redactCephConfig)
  }
}
