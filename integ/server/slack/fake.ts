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

import { Prisma, PrismaClient } from '../../generated/slack/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config, type C } from './config.ts'
import { fileBytes } from './reads.ts'
import { slackRoutes } from './routes.ts'
import { requestToken } from './wire.ts'

// `dms` are Channel rows too: a DM is a channel with no name and a dmUserId,
// which is why the fixture cannot just call them channels.
export const slackFake: Fake<C> = {
  config,
  requestToken,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: { dms: 'Channel', files: 'SlackFile', shares: 'SlackShare' },
  // size and timestamp are DERIVED, so the fixture does not state them and
  // cannot go stale: timestamp is the message ts floored, and size is the byte
  // length of the content, which for a contentPath row lives on disk and would
  // silently disagree with a number baked into the fixture.
  afterSeed: async (db, tenant) => {
    for (const f of await db.slackFile.findMany({ where: { tenant } })) {
      await db.slackFile.update({
        where: { tenant_id: { tenant, id: f.id } },
        data: { size: fileBytes(f).length, timestamp: Math.floor(Number(f.messageTs)) },
      })
    }
  },
  routes: slackRoutes,
}
