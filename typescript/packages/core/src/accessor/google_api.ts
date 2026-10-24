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
import type { Clock } from '../utils/clock.ts'
import { CalendarClient, type CalendarApi } from '../core/gcal/api.ts'
import { DocsClient, type DocsApi } from '../core/gdocs/api.ts'
import { DriveClient, type DriveApi } from '../core/gdrive/api.ts'
import { GmailClient, type GmailApi } from '../core/gmail/api.ts'
import type { TokenManager } from '../core/google/client.ts'
import { SheetsClient, type SheetsApi } from '../core/gsheets/api.ts'
import { SlidesClient, type SlidesApi } from '../core/gslides/api.ts'

export class GoogleApiAccessor extends Accessor {
  readonly tokenManager: TokenManager

  constructor(opts: { tokenManager: TokenManager }) {
    super()
    this.tokenManager = opts.tokenManager
  }

  /** Read token expiry and retry waits on the workspace's clock. */
  override bindClock(clock: Clock): void {
    this.tokenManager.bindClock(clock)
  }

  /** The one door every Drive request goes through. */
  get drive(): DriveApi {
    return new DriveClient(this.tokenManager)
  }

  /** The one door every Docs request goes through. */
  get docs(): DocsApi {
    return new DocsClient(this.tokenManager)
  }

  /** The one door every Sheets request goes through. */
  get sheets(): SheetsApi {
    return new SheetsClient(this.tokenManager)
  }

  /** The one door every Slides request goes through. */
  get slides(): SlidesApi {
    return new SlidesClient(this.tokenManager)
  }

  /** The one door every Gmail request goes through. */
  get gmail(): GmailApi {
    return new GmailClient(this.tokenManager)
  }

  /** The one door every Calendar request goes through. */
  get calendar(): CalendarApi {
    return new CalendarClient(this.tokenManager)
  }
}
