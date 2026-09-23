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
  qingStorToS3Config,
  redactQingStorConfig,
  type QingStorConfig,
  type QingStorConfigRedacted,
} from './config.ts'
import { QINGSTOR_BROWSER_PROMPT } from './prompt.ts'

export type QingStorVFSState = S3AliasVFSState<QingStorConfigRedacted>

export class QingStorVFS extends S3AliasVFS<QingStorConfig, QingStorConfigRedacted> {
  override readonly prompt: string = QINGSTOR_BROWSER_PROMPT

  constructor(config: QingStorConfig) {
    super(VFSName.QINGSTOR, config, qingStorToS3Config(config), redactQingStorConfig)
  }
}
