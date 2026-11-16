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

import { Prisma, PrismaClient } from '../../generated/linear/index.js'
import { route } from '../kit/typescript/route.ts'
import type { Ctx, KitRoute } from '../kit/typescript/route.ts'
import type { Fake } from '../kit/typescript/base.ts'
import type { Dmmf } from '../kit/typescript/seed.ts'
import type { Reply } from '../kit/typescript/types.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { OPS, errorsReply } from './ops.ts'
import { PyError, pyDict, pyStrOr } from './pyval.ts'
import { afterSeed } from './seed.ts'

// The whole surface is one POST. Which operation runs is read off the first
// `query <Name>` or `mutation <Name>` in the document, not off the path and
// not off a parsed selection set: this fake answers a fixed set of documents
// the client ships, so the name is the routing key and the field list is
// assumed rather than honoured.
//
// The class is spelled out rather than written `\w`, because the two languages
// disagree about what that means: python's is unicode-aware and JavaScript's
// is ASCII, so `query Teams` with an accented letter in it parsed as a name
// one character long and the refusal named the wrong operation.
const OP_RE = /(?:query|mutation)\s+([\p{L}\p{N}_]+)/u

const graphql = async (ctx: Ctx<C>): Promise<Reply> => {
  // A body the old fake could not read was a crash, not a refusal: it called
  // request.json() and then .get() on the result, so an empty body, a
  // malformed one, and a JSON array all answered 500. The kit's envelope is
  // that 500; only its body differs, and aiohttp's crash page is not JSON at
  // all so no shape could match it.
  if (ctx.body.length === 0) throw new PyError('request body is not JSON')
  const body = pyDict(ctx.json())
  const query = pyStrOr(body.query)
  const match = OP_RE.exec(query)
  if (match === null) return errorsReply('could not parse operation')
  const name = match[1] ?? ''
  const op = OPS.get(name.toLowerCase())
  if (op === undefined) return errorsReply(`unknown operation: ${name}`)
  return op(ctx, body.variables)
}

// Marked as a write although most operations only read: one path carries both,
// so the serial queue cannot be decided per request without parsing the body
// in the router. Serializing every GraphQL call is the cheap side of that
// trade, and it is what keeps two concurrent issueCreates from minting the
// same issue number.
export const linearFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  defaultTenants: ['default'],
  afterSeed: async (db, tenant, _counts, _extras, _fixtureRoot, _epoch, sql): Promise<void> => {
    await afterSeed(db, tenant, sql)
  },
  routes: (): KitRoute<C>[] => [route('POST', '/graphql', graphql, { write: true })],
}
