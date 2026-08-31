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

import { Prisma, PrismaClient } from '../../../generated/selftest/index.js'
import { parseConfig } from '../typescript/config.ts'
import { schemaFor } from '../typescript/fixture.ts'
import { idWhere, tenantWhere } from '../typescript/tenant.ts'
import { route } from '../typescript/route.ts'
import type { Ctx, KitRoute } from '../typescript/route.ts'
import type { Fake } from '../typescript/base.ts'
import type { Dmmf } from '../typescript/seed.ts'
import type { JsonValue, Reply } from '../typescript/types.ts'

type C = PrismaClient

const config = parseConfig({
  service: 'selftest',
  schema: schemaFor('selftest'),
  tenantKind: 'pk-column',
  mintSharing: 'global',
  mintFormat: '{kind}_new_{n}',
})

function cardJson(row: {
  id: string
  title: string
  seq: number
  createdAt: string | null
}): JsonValue {
  return { id: row.id, title: row.title, seq: row.seq, createdAt: row.createdAt }
}

async function listBoards(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.board.findMany({
    where: tenantWhere(ctx.tenant, config.tenantKind),
    orderBy: { seq: 'asc' },
    include: { owner: true },
  })
  return {
    status: 200,
    body: {
      boards: rows.map((b) => ({
        id: b.id,
        name: b.name,
        seq: b.seq,
        owner: b.owner === null ? null : { id: b.owner.id, name: b.owner.name },
      })),
    },
  }
}

// The ordering trap, both ways. `cards` reads with the explicit seq order the
// seeder stamped; `cardsNaive` is the same relation read through `include`
// with no orderBy, which is what every fake did before and is the thing the
// selftest exists to show is not fixture order.
async function listCards(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.card.findMany({
    where: { ...tenantWhere(ctx.tenant, config.tenantKind), boardId: ctx.params.board ?? '' },
    orderBy: { seq: 'asc' },
  })
  return { status: 200, body: { cards: rows.map(cardJson) } }
}

async function listCardsNaive(ctx: Ctx<C>): Promise<Reply> {
  const board = await ctx.db.board.findUnique({
    where: idWhere<Prisma.BoardWhereUniqueInput>(
      ctx.tenant,
      ctx.params.board ?? '',
      config.tenantKind,
    ),
    include: { cards: true },
  })
  if (board === null) return { status: 404, body: { error: 'no_board' } }
  return { status: 200, body: { cards: board.cards.map(cardJson) } }
}

async function getCard(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.card.findUnique({
    where: idWhere<Prisma.CardWhereUniqueInput>(
      ctx.tenant,
      ctx.params.card ?? '',
      config.tenantKind,
    ),
  })
  if (row === null) return { status: 404, body: { error: 'no_card' } }
  return { status: 200, body: cardJson(row) }
}

async function createCard(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json()
  const title =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.title === 'string'
      ? body.title
      : 'untitled'
  const boardId = ctx.params.board ?? ''
  const seq = await ctx.db.card.count({
    where: { ...tenantWhere(ctx.tenant, config.tenantKind), boardId },
  })
  const row = await ctx.db.card.create({
    data: {
      tenant: ctx.tenant,
      id: ctx.minter.mint('crd'),
      boardId,
      title,
      seq,
      createdAt: ctx.clock.nowIso(),
    },
  })
  return { status: 201, body: cardJson(row) }
}

// A retitle done as delete + re-create, which is how several of the live
// fakes implement an update. It is also the shortest honest way to show the
// ordering trap: the row keeps its seq, so the ordered read is unchanged,
// while the naive `include` read moves it to the end because that is where
// SQLite put the new row.
async function retitleCard(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json()
  const title =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.title === 'string'
      ? body.title
      : 'untitled'
  const where = idWhere<Prisma.CardWhereUniqueInput>(
    ctx.tenant,
    ctx.params.card ?? '',
    config.tenantKind,
  )
  const old = await ctx.db.card.findUnique({ where })
  if (old === null) return { status: 404, body: { error: 'no_card' } }
  await ctx.db.card.delete({ where })
  const row = await ctx.db.card.create({
    data: {
      tenant: old.tenant,
      id: old.id,
      boardId: old.boardId,
      title,
      seq: old.seq,
      createdAt: ctx.clock.nowIso(),
    },
  })
  return { status: 200, body: cardJson(row) }
}

// A write with a deliberate gap between its two mutations, so a read racing it
// has a window wide enough to observe deterministically. Every migrated fake
// has this shape naturally (several awaited Prisma calls), but their gaps are
// microseconds and a test built on one is a coin flip. `?ms=` makes the window
// an input instead. The card is created as `phase-1` and updated to `phase-2`,
// so a read that lands in the gap is not merely stale, it is NAMED stale.
async function twoPhaseCard(ctx: Ctx<C>): Promise<Reply> {
  const ms = Number(ctx.query.get('ms') ?? '0')
  const id = ctx.minter.mint('crd')
  const boardId = ctx.params.board ?? ''
  const seq = await ctx.db.card.count({
    where: { ...tenantWhere(ctx.tenant, config.tenantKind), boardId },
  })
  await ctx.db.card.create({
    data: {
      tenant: ctx.tenant,
      id,
      boardId,
      title: 'phase-1',
      seq,
      createdAt: ctx.clock.nowIso(),
    },
  })
  await new Promise((r) => setTimeout(r, Number.isFinite(ms) ? ms : 0))
  const row = await ctx.db.card.update({
    where: idWhere<Prisma.CardWhereUniqueInput>(ctx.tenant, id, config.tenantKind),
    data: { title: 'phase-2' },
  })
  return { status: 201, body: cardJson(row) }
}

export const selftestFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  defaultTenants: ['default'],
  // A seed that FAILS, on demand. The failure paths are the ones no ordinary
  // request reaches, and they are where the interesting bugs were: a tenant
  // left marked seeded, and a throwaway build client left open and holding
  // SQLite files. A reserved tenant name is the only way to reach them from
  // the outside, so the selftest fake grows one.
  afterSeed: async (
    db: C,
    tenant: string,
    _counts: Record<string, number>,
    _extras: Record<string, JsonValue>,
    _fixtureRoot: string,
    epoch: string | undefined,
  ): Promise<void> => {
    if (tenant === 'boom') throw new Error('selftest fake: afterSeed refused tenant boom')
    // A seed slow enough to be raced on purpose. The window a request has to
    // slip into is a few milliseconds otherwise, so a test for it would pass
    // by luck rather than by holding the invariant.
    if (tenant === 'slow') await new Promise((ok) => setTimeout(ok, 300))
    // A seed that WRITES the epoch, which is what makes the epoch an input to
    // the seed and therefore part of the seeded-template key. Its own tenant so
    // that no other check sees the extra row; gws is the real case (it stamps a
    // createdTime on every row it seeds through the Drive table).
    if (tenant === 'stamped') {
      await db.card.create({
        data: {
          tenant,
          id: 'crd_epoch',
          boardId: 'brd_1',
          title: epoch ?? 'no-epoch',
          seq: 99,
          createdAt: epoch ?? null,
        },
      })
    }
  },
  // Opted in, because the refusal is opt-in and this is where it is covered.
  // A fake that says nothing here keeps serving unseeded tenants, which is
  // what dropbox and the other lazily-created accounts need.
  // The env switch makes this fake stand in for one that opts OUT, which is a
  // shape that has to be covered separately: without the refusal a request is
  // not held at it, so it reaches the ctx and creates the run itself.
  ...(process.env.SELFTEST_LAZY_TENANTS === '1'
    ? {}
    : {
        unknownTenant: (tenant: string) => ({
          status: 401,
          body: {
            error: 'unknown_tenant',
            message: `selftest fake: no tenant ${tenant}; seed it with /reset`,
          },
        }),
      }),
  routes: (): KitRoute<C>[] => [
    // Echoes what a HANDLER sees, which is not what the router matched on: the
    // run prefix has to be gone from ctx.url too, because handlers render this
    // pathname into responses and one fake looks rows up by it.
    route('GET', '/whereami', (ctx) => ({
      status: 200,
      body: {
        path: ctx.url.pathname,
        run: ctx.run,
        query: ctx.url.search,
        // What a fake mints for the client to come BACK to. github's Link
        // header is built this way, and a self URL missing the prefix sends
        // the client into the default run for page two.
        self: `${ctx.runPrefix}${ctx.url.pathname}`,
      },
    })),
    route('GET', '/boards', listBoards),
    route('GET', '/boards/:board/cards', listCards),
    route('GET', '/boards/:board/cards-naive', listCardsNaive),
    route('GET', '/cards/:card', getCard),
    route('POST', '/boards/:board/cards', createCard, { write: true }),
    route('PUT', '/cards/:card', retitleCard, { write: true }),
    route('POST', '/boards/:board/two-phase', twoPhaseCard, { write: true }),
  ],
}
