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
import { createDriveItem, touchNative } from '../drive/item.ts'
import type { C } from '../store/client.ts'
import type { FormDoc } from '../store/types.ts'
import { asObj, asObjArr, asStr } from '../wire/json.ts'
import { FORM_MIME } from '../wire/mime.ts'
import { NOT_FOUND, idVerbOf, ok, unknownRoute } from '../wire/reply.ts'
import { applyFormRequest, fmtForm } from './form.ts'

// The old fake spelled a form id and a response id `[^/:]+`.
const ID: RouteOpts = { classes: { id: 'id' } }
const RESPONSE: RouteOpts = { classes: { id: 'id', responseId: 'id' } }

export function formsRoutes(): KitRoute<C>[] {
  return [
    route(
      'POST',
      '/v1/forms',
      (ctx) => {
        const info = asObj(asObj(ctx.json()).info)
        const title = asStr(info.title) ?? 'Untitled form'
        const documentTitle = asStr(info.documentTitle) ?? title
        // Created through the Drive table on purpose: a form's formId IS its
        // Drive file id (verified against real Google), which is the only way
        // an agent can find an existing form, since the Forms API has no list
        // method.
        const item = createDriveItem(
          ctx.db,
          documentTitle,
          FORM_MIME,
          [],
          Buffer.alloc(0),
          ctx.db.nextId('form'),
        )
        const form: FormDoc = {
          formId: item.id,
          title,
          documentTitle,
          items: [],
          responses: [],
          revision: 1,
        }
        ctx.db.forms.set(form.formId, form)
        return ok(fmtForm(form))
      },
      { write: true },
    ),
    route(
      'GET',
      '/v1/forms/:id/responses/:responseId',
      (ctx) => {
        const form = ctx.db.forms.get(ctx.params.id ?? '')
        const found = form?.responses.find((r) => r.responseId === ctx.params.responseId)
        if (found === undefined) return NOT_FOUND
        return ok(found)
      },
      RESPONSE,
    ),
    route(
      'GET',
      '/v1/forms/:id/responses',
      (ctx) => {
        const form = ctx.db.forms.get(ctx.params.id ?? '')
        if (form === undefined) return NOT_FOUND
        return ok({ responses: form.responses })
      },
      ID,
    ),
    route(
      'GET',
      '/v1/forms/:id',
      (ctx) => {
        const form = ctx.db.forms.get(ctx.params.id ?? '')
        if (form === undefined) return NOT_FOUND
        return ok(fmtForm(form))
      },
      ID,
    ),
    route(
      'POST',
      '/v1/forms/:target',
      (ctx) => {
        const id = idVerbOf(ctx.params.target ?? '', 'batchUpdate')
        if (id === null) return unknownRoute('POST', ctx.url.pathname)
        const form = ctx.db.forms.get(id)
        if (form === undefined) return NOT_FOUND
        const requests = asObjArr(asObj(ctx.json()).requests)
        for (const req of requests) applyFormRequest(ctx.db, form, req)
        form.revision += 1
        touchNative(ctx.db, form.formId)
        return ok({ form: fmtForm(form), replies: requests.map(() => ({})) })
      },
      { write: true },
    ),
  ]
}
