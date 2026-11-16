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

import type { DatabaseSync } from 'node:sqlite'
import { Prisma, PrismaClient } from '../../generated/airtable/index.js'
import type { Dmmf, Fake, JsonValue } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { airtableRoutes } from './routes.ts'
import { afterSeed } from './seed.ts'
import { authRequired } from './wire.ts'

// How a caller isolates itself: its own RUN, as a leading path segment.
//
//   base URL   ${AIRTABLE_URL}/_run/<run id>/v0
//   seed it    POST ${AIRTABLE_URL}/_run/<run id>/reset   (body {} or {"epoch": ...})
//   token      Authorization: Bearer patIntegFullAccess.fake   (or any fixture token)
//
// A run nobody has reset answers every request 401 AUTHENTICATION_REQUIRED,
// which is literally true (its world holds no tokens) and loud, where an empty
// world would read as an empty account. The bare origin is the `default` run,
// seeded at startup, for a curl or a selftest.
export const airtableFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: {
    meta: 'AirtableMeta',
    users: 'AirtableUser',
    tokens: 'AirtableToken',
    bases: 'AirtableBase',
  },
  afterSeed: async (
    db: C,
    tenant: string,
    counts: Record<string, number>,
    extras: Record<string, JsonValue>,
    _fixtureRoot: string,
    _epoch: string | undefined,
    sql: DatabaseSync,
  ): Promise<void> => {
    await afterSeed(db, tenant, counts, extras, sql)
  },
  unknownTenant: (tenant: string) => {
    process.stderr.write(
      `airtable fake: tenant ${tenant} was never seeded in this run; POST <run base>/reset first\n`,
    )
    return authRequired()
  },
  routes: airtableRoutes,
}
