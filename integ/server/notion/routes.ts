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

import { route } from '../kit/typescript/index.ts'
import type { Ctx, KitHandler, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import {
  blockChildren,
  pageMarkdown,
  queryDataSource,
  queryDatabase,
  retrieveBlock,
  retrieveDataSource,
  retrieveDatabase,
  retrievePage,
  retrieveUser,
  listUsers,
  search,
  unauthorized,
  whoami,
} from './reads.ts'
import {
  appendChildrenRoute,
  createCommentRoute,
  createPageRoute,
  deleteBlockRoute,
  listCommentsRoute,
  replaceMarkdown,
  updatePageRoute,
  updateBlockRoute,
} from './writes.ts'

// Every route is behind the token check, so it is applied once here rather
// than as a first line in seventeen handlers. The kit's tenant fallback is
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

export function notionRoutes(): KitRoute<C>[] {
  return [
    get('/v1/users/me', whoami),
    get('/v1/users/:id', retrieveUser),
    get('/v1/users', listUsers),
    get('/v1/pages/:id/markdown', pageMarkdown),
    get('/v1/pages/:id', retrievePage),
    get('/v1/data_sources/:id', retrieveDataSource),
    get('/v1/databases/:id', retrieveDatabase),
    get('/v1/blocks/:id/children', blockChildren),
    get('/v1/blocks/:id', retrieveBlock),
    get('/v1/comments', listCommentsRoute),
    // A query is a POST that reads. It carries its filter in a body, which is
    // why it cannot be a GET, but it must not join the write queue either: the
    // kit already makes a read WAIT for pending writes without queueing behind
    // other reads, which is exactly what a query wants.
    route<C>('POST', '/v1/search', guarded(search)),
    route<C>('POST', '/v1/data_sources/:id/query', guarded(queryDataSource)),
    route<C>('POST', '/v1/databases/:id/query', guarded(queryDatabase)),
    write('POST', '/v1/pages', createPageRoute),
    write('PATCH', '/v1/pages/:id/markdown', replaceMarkdown),
    write('PATCH', '/v1/pages/:id', updatePageRoute),
    write('PATCH', '/v1/blocks/:id/children', appendChildrenRoute),
    write('PATCH', '/v1/blocks/:id', updateBlockRoute),
    write('DELETE', '/v1/blocks/:id', deleteBlockRoute),
    write('POST', '/v1/comments', createCommentRoute),
  ]
}
