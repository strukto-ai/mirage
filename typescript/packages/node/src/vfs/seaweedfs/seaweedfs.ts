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
  redactSeaweedFSConfig,
  seaweedfsToS3Config,
  type SeaweedFSConfig,
  type SeaweedFSConfigRedacted,
} from './config.ts'
import { SEAWEEDFS_PROMPT } from './prompt.ts'

export type SeaweedFSVFSState = S3AliasVFSState<SeaweedFSConfigRedacted>

export class SeaweedFSVFS extends S3AliasVFS<SeaweedFSConfig, SeaweedFSConfigRedacted> {
  override readonly prompt: string = SEAWEEDFS_PROMPT

  constructor(config: SeaweedFSConfig) {
    super(VFSName.SEAWEEDFS, config, seaweedfsToS3Config(config), redactSeaweedFSConfig)
  }
}
