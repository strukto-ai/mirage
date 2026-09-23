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

import { secretStr, z } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf } from '@struktoai/mirage-core/vfs/secrets'
import { API_BASE } from './constants.ts'

/**
 * What an `hf` install is configured with.
 *
 * An account CLI, so it declares this and reaches the Hub directly; it
 * consults no mount. The token is optional because the Hub serves every
 * public repository anonymously, and the verbs that need one (`auth whoami`,
 * anything that writes) say so when it is missing rather than failing at the
 * transport.
 */
export const HfConfigSchema = z.object({
  token: secretStr().optional(),
  endpoint: z.string().default(API_BASE),
})

export type HfConfig = ConfigOf<typeof HfConfigSchema>

export function hfEndpoint(config: HfConfig): string {
  const endpoint = config.endpoint
  return endpoint === '' ? API_BASE : endpoint
}
