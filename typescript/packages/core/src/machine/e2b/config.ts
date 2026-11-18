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
import type { PauseAction } from '../types.ts'
import { ON_PAUSE } from './constants.ts'

/** How to reach an E2B sandbox: yours, by its id, or one Mirage starts from a template. */
export interface E2BConfig extends MachineConfig {
  /**
   * Id of a sandbox you created (`e2b sandbox spawn` or the SDK),
   * with workspace files visible at matching paths when commands need them.
   * Unset, Mirage starts one from `template` at the first run that needs it.
   */
  sandboxId?: string
  /** The template Mirage starts a sandbox from when no `sandboxId` is given; E2B's `base` unset. */
  template?: string
  /**
   * Seconds a sandbox Mirage started stays up once Mirage's work there ends,
   * before E2B pauses it; the next work resumes it. Unset is
   * `IDLE_TIMEOUT_SECONDS`. A sandbox you brought keeps its own timeout.
   */
  idleTimeout?: number
  /** E2B credential; required in browsers; Node falls back to E2B_API_KEY. */
  apiKey?: string
  /** `pause`: pause the sandbox when the workspace pauses; unset leaves it as it is. */
  onPause?: PauseAction
}

export const E2B_CONFIG_FIELDS: ConfigFields = {
  ...BASE_CONFIG_FIELDS,
  sandboxId: { type: 'string' },
  template: { type: 'string' },
  idleTimeout: { type: 'number' },
  apiKey: { type: 'string' },
  onPause: { type: 'string', options: ON_PAUSE },
}
