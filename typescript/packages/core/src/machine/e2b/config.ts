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

import type { ConfigFields } from '../../runtime/config.ts'
import { BASE_CONFIG_FIELDS, type MachineConfig } from '../config.ts'
import type { SleepAction } from '../types.ts'
import { ON_SLEEP } from './constants.ts'

/** How to reach the user's live E2B sandbox. */
export interface E2BConfig extends MachineConfig {
  /**
   * Id of a sandbox you created (`e2b sandbox spawn` or the SDK),
   * with workspace files visible at matching paths when commands need them.
   */
  sandboxId: string
  /** E2B credential; required in browsers; Node falls back to E2B_API_KEY. */
  apiKey?: string
  /** `pause`: pause the sandbox when the workspace sleeps; unset leaves it as it is. */
  onSleep?: SleepAction
}

export const E2B_CONFIG_FIELDS: ConfigFields = {
  ...BASE_CONFIG_FIELDS,
  sandboxId: { type: 'string', required: true },
  apiKey: { type: 'string' },
  onSleep: { type: 'string', options: ON_SLEEP },
}
