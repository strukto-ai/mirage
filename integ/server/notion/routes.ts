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

import { route, unroutedLine } from '../kit/typescript/index.ts'
import type { Ctx, KitHandler, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { config } from './config.ts'
import {
  blockChildren,
  pageMarkdown,
  queryDataSource,
  queryDatabase,
  retrieveBlock,
  retrieveDataSource,
  retrieveDatabase,
  retrievePage,
  retrievePageProperty,
  retrieveUser,
  listTemplates,
  listUsers,
  search,
  unauthorized,
  whoami,
} from './reads.ts'
import {
  appendChildrenRoute,
  createCommentRoute,
  createDataSourceRoute,
  createDatabaseRoute,
  createPageRoute,
  deleteBlockRoute,
  listCommentsRoute,
  movePageRoute,
  replaceMarkdown,
  updateDataSourceRoute,
  updateDatabaseRoute,
  updatePageRoute,
  updateBlockRoute,
} from './writes.ts'
import { apiError } from './wire.ts'
import { completeUpload, createUpload, getUpload, listUploads, sendUpload } from './uploads.ts'

// Every route is behind the token check, so it is applied once here rather
// than as a first line in every handler. The kit's tenant fallback is
// deliberately permissive (an unreadable vendor token asks for nothing and
// gets the default tenant); Notion is not, and answers 401.
function guarded(handler: KitHandler<C>): KitHandler<C> {
  return async (ctx: Ctx<C>): Promise<Reply> => unauthorized(ctx) ?? (await handler(ctx))
}

function get(path: string, handler: KitHandler<C>): KitRoute<C> {
  return route<C>('GET', path, guarded(handler))
}

function write(method: string, path: string, handler: KitHandler<C>): KitRoute<C> {
  return route<C>(method, path, guarded(handler), { write: true })
}

// A path no route matches, answered the way live Notion answers one (a
// trailing-slash `POST /v1/pages/` gets exactly this). The kit's own reply is a
// 404 in its own shape, which a client reads as "that page does not exist"
// about a page it has just read. It is behind the token check like every
// route, so a caller with no token cannot tell a path that exists from one
// that does not. The stderr line is the kit's `unrouted` line, written here
// because reaching this route means the kit's `unrouted`, which normally
// writes it and which CI greps for, never ran. Declared LAST, so every real
// route wins.
function catchAll(): KitRoute<C>[] {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) =>
    route<C>(
      method,
      '/*rest',
      guarded((ctx: Ctx<C>) => {
        process.stderr.write(`${unroutedLine(config.service, method, ctx.url.pathname)}\n`)
        return apiError(400, 'invalid_request_url', 'Invalid request URL.')
      }),
    ),
  )
}

export function notionRoutes(): KitRoute<C>[] {
  return [
    get('/v1/users/me', whoami),
    get('/v1/users/:id', retrieveUser),
    get('/v1/users', listUsers),
    get('/v1/pages/:id/markdown', pageMarkdown),
    get('/v1/pages/:id/properties/:property', retrievePageProperty),
    get('/v1/pages/:id', retrievePage),
    get('/v1/data_sources/:id/templates', listTemplates),
    get('/v1/data_sources/:id', retrieveDataSource),
    get('/v1/databases/:id', retrieveDatabase),
    get('/v1/blocks/:id/children', blockChildren),
    get('/v1/blocks/:id', retrieveBlock),
    get('/v1/comments', listCommentsRoute),
    get('/v1/file_uploads', listUploads),
    get('/v1/file_uploads/:id', getUpload),
    // A query is a POST that reads. It carries its filter in a body, which is
    // why it cannot be a GET, but it must not join the write queue either: the
    // kit already makes a read WAIT for pending writes without queueing behind
    // other reads, which is exactly what a query wants.
    route<C>('POST', '/v1/search', guarded(search)),
    route<C>('POST', '/v1/data_sources/:id/query', guarded(queryDataSource)),
    route<C>('POST', '/v1/databases/:id/query', guarded(queryDatabase)),
    write('POST', '/v1/pages', createPageRoute),
    write('POST', '/v1/databases', createDatabaseRoute),
    write('PATCH', '/v1/databases/:id', updateDatabaseRoute),
    write('POST', '/v1/data_sources', createDataSourceRoute),
    write('PATCH', '/v1/data_sources/:id', updateDataSourceRoute),
    write('POST', '/v1/pages/:id/move', movePageRoute),
    write('PATCH', '/v1/pages/:id/markdown', replaceMarkdown),
    write('PATCH', '/v1/pages/:id', updatePageRoute),
    write('PATCH', '/v1/blocks/:id/children', appendChildrenRoute),
    write('PATCH', '/v1/blocks/:id', updateBlockRoute),
    write('DELETE', '/v1/blocks/:id', deleteBlockRoute),
    write('POST', '/v1/comments', createCommentRoute),
    write('POST', '/v1/file_uploads', createUpload),
    write('POST', '/v1/file_uploads/:id/send', sendUpload),
    write('POST', '/v1/file_uploads/:id/complete', completeUpload),
    ...catchAll(),
  ]
}
