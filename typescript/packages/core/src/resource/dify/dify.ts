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

import { DifyAccessor } from '../../accessor/dify.ts'
import { DIFY_COMMANDS } from '../../commands/builtin/dify/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { readBytes } from '../../core/dify/read.ts'
import { readdir as difyReaddir } from '../../core/dify/readdir.ts'
import { stat as difyStat } from '../../core/dify/stat.ts'
import { DIFY_OPS } from '../../ops/dify/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import { BaseResource, type Resource } from '../base.ts'
import { resolveDifyConfig, type DifyConfig, type DifyConfigResolved } from './config.ts'
import { DIFY_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(difyReaddir)

export interface DifyResourceOptions {
  config: DifyConfig
}

export class DifyResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.DIFY
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = false
  readonly prompt: string = DIFY_PROMPT
  readonly config: DifyConfigResolved
  readonly accessor: DifyAccessor

  constructor(options: DifyResourceOptions | DifyConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveDifyConfig(config)
    this.accessor = new DifyAccessor(this.config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return DIFY_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return DIFY_COMMANDS
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return resolveGlob(this.accessor, paths, this.index)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readBytes(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return difyReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return difyStat(this.accessor, p, this.index)
  }
}
