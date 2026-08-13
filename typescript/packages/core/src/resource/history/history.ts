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

import { HistoryAccessor } from '../../accessor/history.ts'
import { find as findCore } from '../../core/history/find.ts'
import type { FindOptions } from '../../core/ram/find.ts'
import { read as readCore } from '../../core/history/read.ts'
import { readdir as readdirCore } from '../../core/history/readdir.ts'
import { stat as statCore } from '../../core/history/stat.ts'
import { stream as streamCore } from '../../core/history/stream.ts'
import { HISTORY_COMMANDS } from '../../commands/builtin/history/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import type { Observer } from '../../observe/observer.ts'
import { HISTORY_OPS } from '../../ops/history/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import type { FileStat } from '../../types.ts'
import { type PathSpec, ResourceName } from '../../types.ts'
import { BaseResource, type Resource } from '../base.ts'

export const HISTORY_PREFIX = '/.bash_history'

/**
 * Read-only view resource backing the /.bash_history mount. Renders GNU
 * views from the workspace's hidden recorder on every read; holds no
 * storage of its own.
 */
export class HistoryViewResource extends BaseResource implements Resource {
  readonly kind = ResourceName.HISTORY
  readonly cachesReads = false
  // The view renders from in-memory events, so stat() sizes it by
  // rendering: cheap, no network, and never null.
  readonly sizesAlwaysKnown = true
  readonly accessor: HistoryAccessor

  constructor(observer: Observer) {
    super()
    this.accessor = new HistoryAccessor(observer)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return HISTORY_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return HISTORY_COMMANDS
  }

  streamPath(path: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, path)
  }

  readFile(path: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, path)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, path)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, path)
  }

  find(path: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, path, options)
  }
}
