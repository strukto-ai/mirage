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

import type { TokenManager } from '../core/google/client.ts'
import { GoogleApiAccessor } from './google_api.ts'
import type { GmailConfig } from '../vfs/gmail/config.ts'

export class GmailAccessor extends GoogleApiAccessor {
  readonly config: GmailConfig
  /**
   * Whether the mount walks under a `walkLimit`, asked when a listing runs,
   * since the mount settles its own once mounted; a listing then keeps each
   * message's text for the search.
   */
  readonly capped: () => boolean

  constructor(opts: { tokenManager: TokenManager; config: GmailConfig; capped?: () => boolean }) {
    super(opts)
    this.config = opts.config
    this.capped = opts.capped ?? (() => true)
  }
}
