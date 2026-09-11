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

import { localDate } from '../core/gcal/day.ts'
import type { TokenManager } from '../core/google/client.ts'
import { GoogleApiAccessor } from './google_api.ts'
import type { GCalConfig } from '../resource/gcal/config.ts'

export class GCalAccessor extends GoogleApiAccessor {
  readonly config: GCalConfig

  constructor(opts: { tokenManager: TokenManager; config: GCalConfig }) {
    super(opts)
    this.config = opts.config
  }

  /**
   * The day the default listing window centres on, `YYYY-MM-DD`.
   *
   * Taken in the mount's bucketing zone rather than the host's: the two
   * disagree for several hours a day, so a window centred on the wrong one
   * shifts the whole listing by a day around either midnight.
   *
   * A method rather than a module-level call so a test can pin it and so a
   * long-lived mount does not freeze its window at construction time.
   */
  today(tz: string): string {
    const pinned = this.config.today
    if (pinned !== undefined && pinned !== '') return pinned
    return localDate(Date.now(), tz)
  }
}
