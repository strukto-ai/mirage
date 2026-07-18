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

import { QdrantAccessor } from '../../accessor/qdrant.ts'
import { QDRANT_COMMANDS } from '../../commands/builtin/qdrant/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { resolveGlob } from '../../core/qdrant/glob.ts'
import { read } from '../../core/qdrant/read.ts'
import { readdir as qdrantReaddir } from '../../core/qdrant/readdir.ts'
import { stat as qdrantStat } from '../../core/qdrant/stat.ts'
import { QDRANT_OPS } from '../../ops/qdrant/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import { BaseResource, type Resource } from '../base.ts'
import { resolveQdrantConfig, type QdrantConfig, type QdrantConfigResolved } from './config.ts'
import { QDRANT_PROMPT } from './prompt.ts'

export interface QdrantResourceOptions {
  config: QdrantConfig
}

export class QdrantResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.QDRANT
  readonly isRemote: boolean = true
  readonly supportsSnapshot: boolean = false
  readonly prompt: string = QDRANT_PROMPT
  readonly config: QdrantConfigResolved
  readonly accessor: QdrantAccessor

  constructor(options: QdrantResourceOptions | QdrantConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveQdrantConfig(config)
    this.accessor = new QdrantAccessor(this.config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return QDRANT_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return QDRANT_COMMANDS
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return resolveGlob(this.accessor, paths, this.index)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return read(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return qdrantReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return qdrantStat(this.accessor, p, this.index)
  }
}
