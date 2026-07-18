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

import {
  BaseResource,
  PathSpec,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { HF_COMMANDS } from '../../commands/builtin/hf/index.ts'
import { create as createCore } from '../../core/hf/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/hf/du.ts'
import { exists as existsCore } from '../../core/hf/exists.ts'
import { find as findCore } from '../../core/hf/find.ts'
import { resolveGlob as globCore } from '../../core/hf/glob.ts'
import { mkdir as mkdirCore } from '../../core/hf/mkdir.ts'
import { read as readCore } from '../../core/hf/read.ts'
import { readdir as readdirCore } from '../../core/hf/readdir.ts'
import { stat as statCore } from '../../core/hf/stat.ts'
import { rangeRead as rangeReadCore, stream as streamCore } from '../../core/hf/stream.ts'
import { unlink as unlinkCore } from '../../core/hf/unlink.ts'
import { write as writeCore } from '../../core/hf/write.ts'
import { HF_OPS } from '../../ops/hf/index.ts'

export abstract class HfResource extends BaseResource implements Resource {
  abstract readonly kind: string
  abstract readonly prompt: string
  abstract readonly accessor: HfAccessor
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    readdir: readdirCore,
    stat: statCore,
    read_stream: streamCore,
    range_read: rangeReadCore,
    du_total: duCore,
    du_all: duAllCore,
    exists: existsCore,
    find_flat: findCore,
    write: writeCore,
    create: createCore,
    unlink: unlinkCore,
    mkdir: mkdirCore,
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return HF_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return HF_OPS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p, this.index)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p, this.index)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  mkdir(p: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p, this.index)
  }

  du(p: PathSpec): Promise<number> {
    return duCore(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.resourcePath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                resourcePath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  loadState(_state: unknown): Promise<void> {
    return Promise.resolve()
  }
}
