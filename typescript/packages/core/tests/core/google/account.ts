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

import { GDriveAccessor } from '../../../src/accessor/gdrive.ts'
import { GmailAccessor } from '../../../src/accessor/gmail.ts'
import { TokenManager } from '../../../src/core/google/client.ts'
import type { GoogleConfig } from '../../../src/core/google/config.ts'
import type { Clock } from '../../../src/utils/clock.ts'
import { GoogleAccount as KitAccount, TOKEN } from '../../fixtures/google_account.ts'

export * from '../../fixtures/google_account.ts'

/** An account on the Google Workspace fake, and Mirage's clients signed in to it. */
export class GoogleAccount extends KitAccount {
  /** A Google config signed in to this account, plus `fields`. */
  config(fields: Partial<GoogleConfig> = {}): GoogleConfig {
    return { accessToken: TOKEN, apiBase: this.run.url, ...fields }
  }

  /** A token manager signed in to this account, its retries waiting on `clock`. */
  tokenManager(clock?: Clock, fields: Partial<GoogleConfig> = {}): TokenManager {
    return new TokenManager(this.config(fields), clock)
  }

  /**
   * A Drive accessor signed in to this account, its retries waiting on
   * `clock`; `folderId` among `fields` scopes it to a folder.
   */
  driveAccessor(clock?: Clock, fields: Partial<GoogleConfig> = {}): GDriveAccessor {
    return new GDriveAccessor({ tokenManager: this.tokenManager(clock, fields) })
  }

  /** A Gmail accessor signed in to this account, its retries waiting on `clock`. */
  gmailAccessor(clock?: Clock, fields: Partial<GoogleConfig> = {}): GmailAccessor {
    const config = this.config(fields)
    return new GmailAccessor({ tokenManager: new TokenManager(config, clock), config })
  }
}
