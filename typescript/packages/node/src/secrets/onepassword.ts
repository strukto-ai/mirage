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

import type { Client } from '@1password/sdk'
import type { OnePasswordConfig } from '@struktoai/mirage-core/secrets/config'
import {
  INTEGRATION_NAME,
  readOnepassword,
  serviceAccountToken,
} from '@struktoai/mirage-core/secrets/onepassword'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'
import { VERSION } from '../version.ts'

// The ref grammar and the item reads are core's, shared with the
// Worker's source; this half loads the SDK from the node install.
export {
  INTEGRATION_NAME,
  NOTES_KEY,
  OP_SCHEME,
  TOKEN_VAR,
  fieldsFromItem,
  findItemId,
  findVaultId,
  parseOpRef,
} from '@struktoai/mirage-core/secrets/onepassword'

/**
 * Authenticate a 1Password SDK client.
 *
 * The SDK loads on first use (the lazy-module trick Python spells as
 * an import path). Built per fetch rather than cached, because a
 * fetched value lands on a session var and never refetches, so a cache
 * would keep an authenticated handle alive long past the line that
 * needed one.
 *
 * Throws SecretsError when neither the config nor the env carries a
 * service account token, before the SDK loads.
 */
export async function onepasswordClient(config: OnePasswordConfig): Promise<Client> {
  const token = serviceAccountToken(config)
  const { createClient } = await import('@1password/sdk')
  return await createClient({
    auth: token,
    integrationName: INTEGRATION_NAME,
    integrationVersion: VERSION,
  })
}

/** Fetch one secret from 1Password; see core's `readOnepassword`. */
export async function fetchOnepassword(
  config: OnePasswordConfig,
  ref: string,
): Promise<ResolvedSecret> {
  return readOnepassword(ref, () => onepasswordClient(config))
}
