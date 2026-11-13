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

import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { BASE_CONFIG_FIELDS, type MachineConfig } from '@struktoai/mirage-core/machine/config'
import type { PauseAction } from '@struktoai/mirage-core/machine/types'
import { ON_PAUSE } from './constants.ts'

/** How to reach the user's running microVM. */
export interface MicrosandboxConfig extends MachineConfig {
  /** Name of a running sandbox whose guest serves the workspace paths. */
  sandbox: string
  /** `pause`: pause the sandbox when the workspace pauses; unset leaves it as it is. */
  onPause?: PauseAction
}

export const MICROSANDBOX_CONFIG_FIELDS: ConfigFields = {
  ...BASE_CONFIG_FIELDS,
  sandbox: { type: 'string', required: true },
  onPause: { type: 'string', options: ON_PAUSE },
}
