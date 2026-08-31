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
import { DOC_MIME } from '../wire/mime.ts'
import { NOT_FOUND, idVerbOf, ok, unknownRoute } from '../wire/reply.ts'
import { docsBatchUpdate } from './batch.ts'
import { fmtDocument } from './body.ts'

// The old fake spelled a document id `[^/:]+`.
const ID: RouteOpts = { classes: { id: 'id' } }

export function docsRoutes(): KitRoute<C>[] {
  return [
    route(
      'POST',
      '/v1/documents',
      (ctx) => {
        const title = String(asObj(ctx.json()).title ?? 'Untitled document')
        const item = createDriveItem(
          ctx.db,
          title,
          DOC_MIME,
          [],
          Buffer.alloc(0),
          ctx.db.nextId('doc'),
        )
        return ok(fmtDocument(ctx.db, item.id))
      },
      { write: true },
    ),
    route(
      'GET',
      '/v1/documents/:id',
      (ctx) => {
        const id = ctx.params.id ?? ''
        if (!ctx.db.docs.has(id)) return NOT_FOUND
        return ok(fmtDocument(ctx.db, id))
      },
      ID,
    ),
    route(
      'POST',
      '/v1/documents/:target',
      (ctx) => {
        const id = idVerbOf(ctx.params.target ?? '', 'batchUpdate')
        if (id === null) return unknownRoute('POST', ctx.url.pathname)
        return docsBatchUpdate(ctx.db, id, asObjArr(asObj(ctx.json()).requests))
      },
      { write: true },
    ),
  ]
}
