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

import type { Ctx, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { treeOf } from './store.ts'
import type { RepoRow } from './store.ts'
import { authedRoute, fail, param, route, withRepo } from './http.ts'
import { repoRoutes } from './repos.ts'
import { contentRoutes } from './contents.ts'
import { gitRoutes } from './git.ts'
import { graphqlRoutes } from './graphql.ts'
import { issueRoutes } from './issues.ts'
import { pullRoutes } from './pulls.ts'
import { releaseRoutes } from './releases.ts'
import { actionRoutes } from './actions.ts'
import { adminRoutes } from './admin.ts'
import { compareRoutes } from './compare.ts'
import { pageRoutes } from './pages.ts'
import { searchRoutes } from './search.ts'
import { insightRoutes } from './insights.ts'
import { stripSlash } from '../kit/typescript/index.ts'

// A client reading one file fetches it from the raw host rather than the API,
// and decides text from binary by the Content-Type it gets back, so serving
// everything as octet-stream would base64 the whole repository. The fixture is
// text apart from the stubbed binaries, so the split is on whether the bytes
// decode as UTF-8.
function looksTextual(data: Buffer): boolean {
  return Buffer.compare(Buffer.from(data.toString('utf8'), 'utf8'), data) === 0
}

async function rawContent(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const files = await treeOf(ctx.db, ctx.tenant, repo, param(ctx, 'ref'))
  if (files === null) return fail(404, 'Not Found')
  const data = files.get(stripSlash(param(ctx, 'path')))
  if (data === undefined) return fail(404, 'Not Found')
  const type = looksTextual(data) ? 'text/plain' : 'application/octet-stream'
  return { status: 200, body: data, headers: { 'Content-Type': type } }
}

// The raw host is not the API host on github.com, but an Enterprise install
// serves both from one origin, under /raw/. It is registered once rather than
// once per API prefix, because it is not an API route.
export function githubRoutes(): KitRoute<C>[] {
  return [
    ...repoRoutes(),
    ...graphqlRoutes(),
    ...adminRoutes(),
    // Before contentRoutes, and that is load-bearing. The kit router takes the
    // first registered match, not the most specific one, and contents claims
    // `commits/*ref` for a commit whose ref may itself contain a slash. That
    // splat swallows `commits/<sha>/status` and `commits/<sha>/check-runs`, so
    // the two of them have to be offered first.
    ...actionRoutes(),
    ...contentRoutes(),
    ...gitRoutes(),
    ...issueRoutes(),
    ...pullRoutes(),
    ...releaseRoutes(),
    ...compareRoutes(),
    ...pageRoutes(),
    ...searchRoutes(),
    ...insightRoutes(),
    route<C>('GET', '/raw/:owner/:repo/:ref/*path', authedRoute(withRepo(rawContent))),
  ]
}
