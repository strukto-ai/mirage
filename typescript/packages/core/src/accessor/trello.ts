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
import type { TrelloTransport } from '../core/trello/client.ts'
import { WALK_LIMIT } from '../vfs/constants.ts'

/**
 * The mount's handle: the transport plus the configured visibility filter.
 * The filter lives here rather than being threaded per call because the
 * python twin reads it off `accessor.config`, and a workspace or board
 * outside it must be invisible on every surface, not only on the listings
 * that remembered to pass it.
 */
export class TrelloAccessor extends Accessor {
  readonly transport: TrelloTransport
  readonly workspaceId: string | null
  readonly boardIds: readonly string[] | null
  readonly walkLimit: number

  constructor(
    transport: TrelloTransport,
    options: { workspaceId?: string; boardIds?: readonly string[]; walkLimit?: number } = {},
  ) {
    super()
    this.transport = transport
    this.workspaceId = options.workspaceId ?? null
    this.boardIds = options.boardIds ?? null
    this.walkLimit = options.walkLimit ?? WALK_LIMIT
  }
}
