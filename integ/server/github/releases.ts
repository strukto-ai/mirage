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

import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { scope } from './store.ts'
import type { RepoRow } from './store.ts'
import {
  authedRoute,
  everywhere,
  fail,
  jsonBodyOf,
  pagedReply,
  param,
  route,
  str,
  withRepo,
} from './http.ts'

const CREATED_AT = '2026-01-01T00:00:00Z'

export interface ReleaseRow {
  id: number
  tagName: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  targetCommitish: string
  createdAt: string
}

export function releaseJson(repo: RepoRow, row: ReleaseRow): JsonValue {
  return {
    id: row.id,
    url: `https://api.github.com/repos/${repo.fullName}/releases/${String(row.id)}`,
    tag_name: row.tagName,
    target_commitish: row.targetCommitish,
    name: row.name,
    body: row.body,
    draft: row.draft,
    prerelease: row.prerelease,
    created_at: row.createdAt,
    published_at: row.createdAt,
    html_url: `https://github.com/${repo.fullName}/releases/tag/${row.tagName}`,
  }
}

async function releaseRows(ctx: Ctx<C>, repo: RepoRow): Promise<ReleaseRow[]> {
  return (await ctx.db.githubRelease.findMany({
    where: { ...scope(ctx.tenant), repo: repo.fullName },
    orderBy: { seq: 'asc' },
  })) as ReleaseRow[]
}

async function listReleases(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const rows = await releaseRows(ctx, repo)
  return pagedReply(
    ctx,
    rows.reverse().map((r) => releaseJson(repo, r)),
  )
}

async function createRelease(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const body = jsonBodyOf(ctx)
  const tag = str(body, 'tag_name').trim()
  if (tag === '') return fail(422, 'Validation Failed')
  const rows = await releaseRows(ctx, repo)
  if (rows.some((r) => r.tagName === tag)) return fail(422, 'Validation Failed')
  const row: ReleaseRow = {
    id: rows.length + 1,
    tagName: tag,
    targetCommitish: str(body, 'target_commitish') || repo.defaultBranch,
    name: str(body, 'name') || tag,
    body: str(body, 'body'),
    draft: body.draft === true,
    prerelease: body.prerelease === true,
    createdAt: CREATED_AT,
  }
  await ctx.db.githubRelease.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, ...row, seq: row.id },
  })
  return { status: 201, body: releaseJson(repo, row) }
}

// The latest release is the newest that is neither a draft nor a prerelease,
// which is the vendor's rule and not simply the last row.
async function latestRelease(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const rows = await releaseRows(ctx, repo)
  const row = rows.reverse().find((r) => !r.draft && !r.prerelease)
  return row === undefined ? fail(404, 'Not Found') : { status: 200, body: releaseJson(repo, row) }
}

async function releaseByTag(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const tag = param(ctx, 'tag')
  const rows = await releaseRows(ctx, repo)
  const row = rows.find((r) => r.tagName === tag)
  return row === undefined ? fail(404, 'Not Found') : { status: 200, body: releaseJson(repo, row) }
}

export function releaseRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('GET', `${p}/repos/:owner/:repo/releases`, authedRoute(withRepo(listReleases))),
    route<C>('POST', `${p}/repos/:owner/:repo/releases`, authedRoute(withRepo(createRelease)), {
      write: true,
    }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/releases/latest`,
      authedRoute(withRepo(latestRelease)),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/releases/tags/:tag`,
      authedRoute(withRepo(releaseByTag)),
    ),
  ])
}
