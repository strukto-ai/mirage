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

import { Prisma, PrismaClient } from '../../generated/notion/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { notionRoutes } from './routes.ts'
import { apiError } from './wire.ts'

export const notionFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  // Every root key needs one: the kit derives `cards` -> `Card` by stripping an
  // English plural, and none of Notion's tables are named after their fixture
  // key once the vendor prefix is on them.
  seedRoots: {
    meta: 'NotionMeta',
    databases: 'NotionDatabase',
    pages: 'NotionPage',
    blocks: 'NotionBlock',
    comments: 'NotionComment',
    users: 'NotionUser',
  },
  // The token both the conformance runner and the MCP parity run authenticate
  // with. A bare start therefore serves the fixture under the same name the
  // fake this replaces seeded at startup; the battery resets to a per-run
  // tenant on top of it.
  defaultTenants: ['integ-test'],
  // Notion cannot tell an unknown token from a malformed one, and says the
  // same thing about both, so this is word for word what `unauthorized`
  // answers a request carrying no token at all.
  unknownTenant: () => apiError(401, 'unauthorized', 'API token is invalid.'),
  routes: notionRoutes,
}
