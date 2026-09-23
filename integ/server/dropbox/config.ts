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
import type { PrismaClient } from '../../generated/dropbox/index.js'

export type C = PrismaClient

// tenantFromBearer is the whole reason one process can serve the several
// isolated accounts a target mounts. /oauth2/token echoes the caller's refresh
// token back as the access token, so the account rides the ordinary
// Authorization header the RPC layer already sends on every call, and no
// mirage-only header has to reach into a VFS's request builder.
export const config = parseConfig({
  service: 'dropbox',
  schema: schemaFor('dropbox'),
  defaultPort: 5088,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
})

// The vendor's default page size for list_folder. A client that ignores
// has_more sees a short listing, which is the bug the pagination loop exists
// to catch, so the fake pages even when everything fits.
export const LIST_LIMIT = 2000

// search_v2's default max_results.
export const SEARCH_LIMIT = 100
