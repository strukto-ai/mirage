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

/** How to reach the user's boxd machine. */
export interface BoxdConfig extends MachineConfig {
  /** Id of a machine you created (`boxd machine new`, the console or the SDK). */
  machineId: string
  /** boxd API key; absent reads BOXD_API_KEY. */
  apiKey?: string
  /** The machine's region (`fra`, `nyc`); absent reads BOXD_REGION, then the account's default. */
  region?: string
}

export const BOXD_CONFIG_FIELDS: ConfigFields = {
  ...BASE_CONFIG_FIELDS,
  machineId: { type: 'string', required: true },
  apiKey: { type: 'string' },
  region: { type: 'string' },
}
