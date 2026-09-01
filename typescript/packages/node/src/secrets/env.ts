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

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

import type { EnvConfig } from './config.ts'

/**
 * Read the host process environment as one secret.
 *
 * `ref` must be empty (the process env has no sub-address); a managed
 * entry's `key` selects the variable to read.
 */
export function fetchEnv(_config: EnvConfig, ref: string): Promise<ResolvedSecret> {
  if (ref !== '') {
    return Promise.reject(
      new SecretsError(
        `the 'env' source takes no ref (the process env has no sub-address), got '${ref}'`,
      ),
    )
  }
  const fields: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') fields[name] = value
  }
  return Promise.resolve({ fields })
}
