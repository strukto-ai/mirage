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
import type { LinearTransport } from '../core/linear/client.ts'

/**
 * The mount's handle: the transport plus the configured team filter. The
 * filter lives here rather than being threaded per call because the python
 * twin reads it off `accessor.config`, and a team outside it must be
 * invisible on every surface, not only on the listings that remembered to
 * pass it.
 */
export class LinearAccessor extends Accessor {
  readonly transport: LinearTransport
  readonly teamIds: readonly string[] | null
  /**
   * Whether the mount walks under a `walkLimit`, asked when a listing runs,
   * since the mount settles its own once mounted; a listing then keeps each
   * issue's unsearched text for the search.
   */
  readonly capped: () => boolean

  constructor(
    transport: LinearTransport,
    options: { teamIds?: readonly string[]; capped?: () => boolean } = {},
  ) {
    super()
    this.transport = transport
    this.teamIds = options.teamIds ?? null
    this.capped = options.capped ?? (() => true)
  }
}
