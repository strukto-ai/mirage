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

import { parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { PrismaClient } from '../../generated/box/index.js'

export type C = PrismaClient

// tenantFromBearer: the vendor's developer-token flow hands the client a
// pre-fetched access token which it sends verbatim on every call, so the
// account is already on the wire and each run can take its own.
export const config = parseConfig({
  service: 'box',
  schema: schemaFor('box'),
  defaultPort: 5096,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
  // Box ids are opaque numeric strings, and one counter serves every kind:
  // a folder create advances the number a later file create will get, which
  // is what the vendor's own sequence looks like.
  mintFormat: '{n}',
})

export const ROOT_ID = '0'

// The vendor's ids are ten digits. The counter starts here so the first minted
// id is 1000000001 and no id can collide with the root's "0".
export const ID_BASE = 1000000000

export const DEFAULT_LIMIT = 100

// A Personal account's storage, which users/me reports as space_amount.
export const SPACE_BYTES = 10 * 1024 * 1024 * 1024
