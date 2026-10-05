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

import { Prisma } from '../../generated/gws/index.js'
import { parseConfig, route as kitRoute, schemaFor, unroutedLine } from '../kit/typescript/index.ts'
import type { Ctx, Dmmf, Fake, KitConfig, KitRoute } from '../kit/typescript/index.ts'
import { calendarRoutes } from './calendar/routes.ts'
import { docsRoutes } from './docs/routes.ts'
import { driveRoutes } from './drive/routes.ts'
import { formsRoutes } from './forms/routes.ts'
import { gmailRoutes } from './gmail/routes.ts'
import { sheetsRoutes } from './sheets/routes.ts'
import { slidesRoutes } from './slides/routes.ts'
import { applyExtras } from './seed.ts'
import { dropTenants } from './store/cache.ts'
import { PrismaClient } from './store/client.ts'
import type { C } from './store/client.ts'
import { loadState } from './store/load.ts'
import { saveState } from './store/save.ts'
import { googleError, header, ok, unknownRoute } from './wire/reply.ts'
import { route } from './wire/route.ts'
import type { RouteOpts } from './wire/route.ts'

export const GWS_DEFAULT_PORT = 19999

// `tenantKind: 'pk-column'` is what buys the two things a run-only fake cannot
// have: a /reset SCOPED to the tenants it names, so two hosts sharing one
// server stop deleting each other's world, and a fresh run served by COPYING an
// already-seeded template rather than reseeding from scratch.
//
// Legacy Google credentials select the default tenant. The kit's opt-in
// runTokenPattern can carry a separate run and tenant in the refresh token;
// /token preserves that credential for the subsequent bearer requests.
//
// `mintSharing` is inert now and kept off the config for that reason: gws mints
// through its own persisted Counter rows, because the kit's Minter lives in
// memory and would restart at zero inside a template copy whose rows already
// used the ids.
export const gwsConfig: KitConfig = parseConfig({
  service: 'gws',
  schema: schemaFor('gws'),
  defaultPort: GWS_DEFAULT_PORT,
  tenantKind: 'pk-column',
})

// A path no route matched, answered in google's error envelope rather than the
// kit's. The kit's own `unrouted` is one shape across every fake, which is what
// a caller diffing two of them wants; here it would be the SECOND shape gws
// gives for the same condition, because a path that matches a route whose
// in-segment verb suffix is not one gws serves is already answered by
// `unknownRoute` from inside the handler. One fake, one 404.
//
// It is a route rather than a hook because the kit has no hook, and it is
// declared LAST so every real route wins. The stderr line is the kit's own,
// written here because reaching this route means the kit's `unrouted` -- which
// is what normally writes it, and what CI greps for -- was never called.
function catchAllRoutes(): KitRoute<C>[] {
  const REST: RouteOpts = { classes: { rest: 'rest' } }
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) =>
    route(
      method,
      '/:rest',
      (ctx) => {
        process.stderr.write(`${unroutedLine('gws', method, ctx.url.pathname)}\n`)
        return unknownRoute(method, ctx.url.pathname)
      },
      REST,
    ),
  )
}

function refreshToken(
  _headers: Record<string, string | string[] | undefined>,
  url: URL,
  body: Buffer,
): string | undefined {
  if (url.pathname !== '/token') return undefined
  return new URLSearchParams(body.toString('utf8')).get('refresh_token') ?? undefined
}

// The fixture's credential. It is a bearer as it is, and outside credential
// routing it is the one refresh token /token exchanges.
const FIXTURE_TOKEN = 'gws-integ-token'

function credentialKey(ctx: Ctx<C>, token: string): string {
  return JSON.stringify([ctx.run, ctx.tenant, token])
}

// The fake OAuth exchange every google client makes before its first call.
// Google exchanges only a refresh token it issued, and so does this: the
// fixture credential, or under credential routing a credential that names its
// own run. Anything else is `invalid_grant`. Exchanging whatever arrived made
// the check on every other route a formality, since a caller that was never
// given a token could mint one here and read the fixture's data with it.
function tokenRoutes(issued: Set<string>, runTokenPattern: string): KitRoute<C>[] {
  const routed = runTokenPattern === '' ? null : new RegExp(runTokenPattern)
  return [
    kitRoute('POST', '/token', (ctx) => {
      const token = refreshToken(ctx.headers, ctx.url, ctx.body)
      if (token === undefined || token.trim() === '') {
        return { status: 400, body: { error: 'invalid_request' } }
      }
      if (token !== FIXTURE_TOKEN && routed?.exec(token)?.groups?.run === undefined) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }
      }
      issued.add(credentialKey(ctx, token))
      return ok({
        access_token: token,
        expires_in: 3600,
        token_type: 'Bearer',
      })
    }),
  ]
}

// What this fake does NOT model, kept with the route list because a caller
// reading a 404 needs it: every line below is a deliberate simplification, not
// a bug to report against mirage.
//
// Simplified, all deterministic so both language runners see byte-identical
// responses:
//   - ids and timestamps are counters over a fixed clock, not random
//   - `fields` masks are ignored (full resources are returned), except on
//     spreadsheets.get, whose response is trimmed to the mask, and on
//     updateCells, where the mask decides whether values are touched at all
//   - sheets formulas support literals, A1 cell/range references, + - * /,
//     SUM/AVERAGE/MIN/MAX/COUNT; other syntax reports an explicit error.
//     Locale-aware date/currency input and array formulas are not modeled.
//   - files.list paginates on pageSize/pageToken; the token is the next
//     item's index, so pages are stable for a fixed query
//   - Gmail search matches case-insensitive substrings, not word stems
//
// Known-absent surface, listed so a 404 here reads as "not built yet" rather
// than "mirage sent the wrong request":
//   - Gmail beyond labels.list and messages list/get/insert/send/trash:
//     no messages.modify/untrash/delete/batchModify, no labels CRUD, and no
//     threads or drafts resources at all
//   - drive changes.list / changes.getStartPageToken (needs a change feed)
//   - Sheets requests that need a cell format or style model (repeatCell,
//     copyPaste, conditional formats) and spreadsheets.getByDataFilter;
//     updateCells is served, but only for userEnteredValue, so a format-only
//     request is a no-op
//   - Docs requests that need document structure beyond a text body
//     (insertTable, insertInlineImage, updateTextStyle, bullets)
//   - Slides presentations.pages.getThumbnail, and the shape/table/image
//     geometry requests
//   - Page has no pageType and Sheets no defaultFormat/spreadsheetTheme
//
// Faithful behaviours that matter to the backends, so they are not
// simplifications to "fix": Drive allows duplicate sibling names, folder
// deletes are recursive, creating a file with a google-apps MIME type
// auto-creates the linked Docs/Sheets/Slides resource (and vice versa), every
// content write records a revision that /revisions can list and serve, Gmail
// messages.insert honors internalDateSource=dateHeader, messages.trash swaps
// INBOX for TRASH, Sheets keeps a declared grid per tab beside the sparse cell
// map so an insert or append grows rowCount, object ids are unique across a
// whole presentation so duplicating a slide re-keys its elements, and
// replaceAllText is case-INSENSITIVE unless matchCase is set, in both Docs and
// Slides.
//
// One list, in the order the old single route() function tried its patterns:
// the API-prefixed surfaces first, then Drive, then the editors. Order only
// matters inside a surface, and each module states its own.
export function gwsRoutes(runTokenPattern = gwsConfig.runTokenPattern): KitRoute<C>[] {
  // The fixed fixture token and tokens exchanged on this server are the fake's
  // credentials. Tenant selectors choose data; they never authorize a request.
  // Each routes() call belongs to one runtime, with exchanges scoped by run
  // and tenant so a token issued in one world cannot open another. The routes
  // cannot see the runtime's config, so a caller that starts the fake with a
  // run-token pattern of its own passes the same pattern here.
  const issued = new Set<string>()
  const apiRoutes = [
    ...gmailRoutes(),
    ...calendarRoutes(),
    ...formsRoutes(),
    ...driveRoutes(),
    ...docsRoutes(),
    ...sheetsRoutes(),
    ...slidesRoutes(),
    ...catchAllRoutes(),
  ]
  return [
    ...tokenRoutes(issued, runTokenPattern),
    ...apiRoutes.map((r): KitRoute<C> => ({
      ...r,
      handler: (ctx) => {
        const auth = header(ctx.headers, 'authorization')
        if (auth === '') {
          return googleError(403, "Method doesn't allow unregistered callers.", 'PERMISSION_DENIED')
        }
        const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
        if (
          token === undefined ||
          (token !== FIXTURE_TOKEN && !issued.has(credentialKey(ctx, token)))
        ) {
          return googleError(
            401,
            'Request had invalid authentication credentials.',
            'UNAUTHENTICATED',
          )
        }
        return r.handler(ctx)
      },
    })),
  ]
}

// The base world is fixture rows; only the two states no API call can produce
// ride /reset, as `extras`. The epoch is written into the Meta row here rather
// than left to the first request, because every row this seed creates is
// stamped with it and a seed that guessed would put the template's timestamps
// an unbounded distance from the run's.
export const gwsFake: Fake<C> = {
  config: gwsConfig,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  routes: gwsRoutes,
  requestToken: refreshToken,
  afterSeed: async (db, tenant, _counts, extras, _fixtureRoot, epoch) => {
    const st = await loadState(db, tenant, epoch === undefined ? undefined : Date.parse(epoch))
    applyExtras(st, extras)
    await saveState(db, gwsFake.dmmf, tenant, st)
  },
  // The one thing that changes a tenant's rows with no route involved. It
  // runs BESIDE `afterSeed`, which reaches the rows directly and so keeps the
  // seed reading the file it just wrote rather than the world this drops.
  afterReset: dropTenants,
}
