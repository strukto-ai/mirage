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

import { vi } from 'vitest'
import { GoogleApiAccessor } from '../../../src/accessor/google_api.ts'
import type { CalendarApi } from '../../../src/core/gcal/api.ts'
import type { DocsApi } from '../../../src/core/gdocs/api.ts'
import type { DriveApi } from '../../../src/core/gdrive/api.ts'
import type { GmailApi } from '../../../src/core/gmail/api.ts'
import type { SheetsApi } from '../../../src/core/gsheets/api.ts'
import type { SlidesApi } from '../../../src/core/gslides/api.ts'

/** Each client a Google accessor serves, by its getter. */
export interface GoogleApis {
  drive: DriveApi
  docs: DocsApi
  sheets: SheetsApi
  slides: SlidesApi
  gmail: GmailApi
  calendar: CalendarApi
}

/**
 * Serve each client in `apis` behind every Google accessor, for a test whose
 * VFS builds its own accessor. A call a client leaves out throws. Undone by
 * `vi.restoreAllMocks()`. Mirrors Python's `install_api`.
 */
export function installApi(apis: { [K in keyof GoogleApis]?: Partial<GoogleApis[K]> }): void {
  for (const [service, api] of Object.entries(apis)) {
    vi.spyOn(GoogleApiAccessor.prototype, service as keyof GoogleApis, 'get').mockReturnValue(
      stubApi<object>(service, api) as never,
    )
  }
}

/**
 * A client that answers only the calls a test arms; any other call throws.
 * Mirrors Python's `StubApi`.
 */
export function stubApi<T extends object>(service: string, calls: Partial<T>): T {
  return new Proxy(calls, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined
      if (name in target) return Reflect.get(target, name)
      throw new Error(`the test reached ${service}.${name} without arming it`)
    },
  }) as T
}
