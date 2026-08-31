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

import { route } from '../wire/route.ts'
import type { RouteOpts } from '../wire/route.ts'
import type { KitRoute } from '../../kit/typescript/index.ts'
import { createDriveItem } from '../drive/item.ts'
import type { C } from '../store/client.ts'
import { asObj, asObjArr } from '../wire/json.ts'
import { SLIDE_MIME } from '../wire/mime.ts'
import { NOT_FOUND, idVerbOf, ok, unknownRoute } from '../wire/reply.ts'
import { slidesBatchUpdate } from './batch.ts'
import { fmtPage, fmtPresentation } from './page.ts'

// The old fake spelled a presentation id and a page id `[^/:]+`.
const ID: RouteOpts = { classes: { id: 'id' } }
const PAGE: RouteOpts = { classes: { id: 'id', pageId: 'id' } }

export function slidesRoutes(): KitRoute<C>[] {
  return [
    route(
      'POST',
      '/v1/presentations',
      (ctx) => {
        const title = String(asObj(ctx.json()).title ?? 'Untitled presentation')
        const item = createDriveItem(
          ctx.db,
          title,
          SLIDE_MIME,
          [],
          Buffer.alloc(0),
          ctx.db.nextId('pres'),
        )
        const pres = ctx.db.presentations.get(item.id)
        if (pres === undefined) return NOT_FOUND
        return ok(fmtPresentation(pres, item.id))
      },
      { write: true },
    ),
    route(
      'GET',
      '/v1/presentations/:id/pages/:pageId',
      (ctx) => {
        const pres = ctx.db.presentations.get(ctx.params.id ?? '')
        const slide = pres?.slides.find((s) => s.objectId === ctx.params.pageId)
        if (slide === undefined) return NOT_FOUND
        return ok(fmtPage(slide))
      },
      PAGE,
    ),
    route(
      'GET',
      '/v1/presentations/:id',
      (ctx) => {
        const pres = ctx.db.presentations.get(ctx.params.id ?? '')
        if (pres === undefined) return NOT_FOUND
        return ok(fmtPresentation(pres, ctx.params.id ?? ''))
      },
      ID,
    ),
    route(
      'POST',
      '/v1/presentations/:target',
      (ctx) => {
        const id = idVerbOf(ctx.params.target ?? '', 'batchUpdate')
        if (id === null) return unknownRoute('POST', ctx.url.pathname)
        return slidesBatchUpdate(ctx.db, id, asObjArr(asObj(ctx.json()).requests))
      },
      { write: true },
    ),
  ]
}
