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

import { matched, update } from '../kit/typescript/index.ts'
import { type Db } from './store.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES, DEFAULT_LOGIN, REPO_DATE } from './config.ts'
import type { C } from './config.ts'
import { simpleUser } from './repos.ts'
import { accountOf, branchFor, metaOf, repoByName, visibleHeadOf } from './store.ts'
import type { RepoRow } from './store.ts'
import { authedRoute, everywhere, fail, jsonBodyOf, paged, param, route, withRepo } from './http.ts'

// One Pages build: the commit it built and who pushed it. Its id is its place
// in the site's list, counting from 1.
interface Build {
  commit: string
  pusher: string
}

// A repository's GitHub Pages site, as the Pages endpoints set it, and the
// builds it has had, oldest first. The fake builds instantly, so a site reads
// as built from the moment it exists and every build as done.
interface Site {
  build_type: string
  source: { branch: string; path: string }
  cname: string | null
  https_enforced: boolean
  builds?: Build[]
}

const BUILD_TYPES = ['legacy', 'workflow']
const SOURCE_PATHS = ['/', '/docs']

function siteOf(repo: RepoRow): Site | null {
  return repo.pagesJson === '' ? null : (JSON.parse(repo.pagesJson) as Site)
}

// `<owner>.github.io` is the owner's own site, served at the root; any other
// repository's is served under its name.
function siteUrl(repo: RepoRow): string {
  const host = `${repo.owner.toLowerCase()}.github.io`
  return repo.name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo.name}/`
}

function siteJson(repo: RepoRow, site: Site): JsonValue {
  return {
    url: `https://api.github.com/repos/${repo.fullName}/pages`,
    status: 'built',
    cname: site.cname,
    custom_404: false,
    html_url: siteUrl(repo),
    build_type: site.build_type,
    source: site.source,
    public: metaOf(repo).private !== true,
    protected_domain_state: null,
    pending_domain_unverified_at: null,
    https_enforced: site.https_enforced,
  }
}

async function storeSite(db: Db, tenant: string, repo: RepoRow, site: Site | null): Promise<void> {
  matched(
    update(
      db,
      'GithubRepo',
      { pagesJson: site === null ? '' : JSON.stringify(site) },
      { tenant, fullName: repo.fullName },
    ),
  )
}

// The site with one more build, of whatever its source branch points at now.
async function built(db: Db, tenant: string, repo: RepoRow, site: Site): Promise<Site> {
  const commit = await visibleHeadOf(db, tenant, repo, site.source.branch)
  return { ...site, builds: [...(site.builds ?? []), { commit, pusher: DEFAULT_LOGIN }] }
}

// A push to the branch a site is built from builds it again, as GitHub
// rebuilds a branch-sourced site on every push to that branch. A site a
// workflow publishes is deployed by the workflow, which the fake never runs.
export async function rebuildOnPush(
  db: Db,
  tenant: string,
  fullName: string,
  branch: string,
): Promise<void> {
  const repo = await repoByName(db, tenant, fullName)
  const site = repo === null ? null : siteOf(repo)
  if (repo === null || site === null) return
  if (site.build_type !== 'legacy' || site.source.branch !== branch) return
  await storeSite(db, tenant, repo, await built(db, tenant, repo, site))
}

// The site a body asks for on top of `base`, or null when any field it names
// is not one GitHub takes: a build type it does not know, a source whose
// branch the repository lacks or whose path is neither the root nor /docs.
async function edited(
  ctx: Ctx<C>,
  repo: RepoRow,
  base: Site,
  body: Record<string, JsonValue>,
): Promise<Site | null> {
  const site = { ...base, source: { ...base.source } }
  if (body.build_type !== undefined) {
    if (typeof body.build_type !== 'string' || !BUILD_TYPES.includes(body.build_type)) return null
    site.build_type = body.build_type
  }
  if (body.source !== undefined) {
    const source = body.source
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
    const branch = typeof source.branch === 'string' ? source.branch : ''
    if (branch === '' || (await branchFor(ctx.sql, ctx.tenant, repo, branch)) === null) return null
    const path = source.path ?? '/'
    if (typeof path !== 'string' || !SOURCE_PATHS.includes(path)) return null
    site.source = { branch, path }
  }
  if (body.cname !== undefined) {
    if (body.cname !== null && typeof body.cname !== 'string') return null
    site.cname = body.cname === '' ? null : body.cname
  }
  if (body.https_enforced !== undefined) {
    if (typeof body.https_enforced !== 'boolean') return null
    site.https_enforced = body.https_enforced
  }
  return site
}

async function getSite(_ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const site = siteOf(repo)
  return site === null ? fail(404, 'Not Found') : { status: 200, body: siteJson(repo, site) }
}

// Creating a site takes a source unless the site is built by a workflow,
// which publishes whatever it deploys; one per repository.
async function createSite(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  if (siteOf(repo) !== null) return fail(409, 'GitHub Pages is already enabled.')
  const body = jsonBodyOf(ctx)
  const base: Site = {
    build_type: 'legacy',
    source: { branch: repo.defaultBranch, path: '/' },
    cname: null,
    https_enforced: true,
  }
  const site = await edited(ctx, repo, base, body)
  if (site === null || (site.build_type === 'legacy' && body.source === undefined)) {
    return fail(422, 'Validation Failed')
  }
  await storeSite(ctx.sql, ctx.tenant, repo, await built(ctx.sql, ctx.tenant, repo, site))
  return { status: 201, body: siteJson(repo, site) }
}

async function updateSite(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const current = siteOf(repo)
  if (current === null) return fail(404, 'Not Found')
  const site = await edited(ctx, repo, current, jsonBodyOf(ctx))
  if (site === null) return fail(422, 'Validation Failed')
  // A branch-sourced site moved to another source is built from it.
  const moved =
    site.build_type === 'legacy' &&
    (site.source.branch !== current.source.branch || site.source.path !== current.source.path)
  const next = moved ? await built(ctx.sql, ctx.tenant, repo, site) : site
  await storeSite(ctx.sql, ctx.tenant, repo, next)
  return { status: 204 }
}

async function deleteSite(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  if (siteOf(repo) === null) return fail(404, 'Not Found')
  await storeSite(ctx.sql, ctx.tenant, repo, null)
  return { status: 204 }
}

// A build endpoint's 404, which points at that endpoint's own documentation,
// as GitHub's does (measured 2026-09-30 for the list and the latest build).
function noBuild(anchor: string): Reply {
  return {
    status: 404,
    body: {
      message: 'Not Found',
      documentation_url: `https://docs.github.com/rest/pages/pages#${anchor}`,
    },
  }
}

async function buildJson(ctx: Ctx<C>, repo: RepoRow, build: Build, id: number): Promise<JsonValue> {
  return {
    url: `https://api.github.com/repos/${repo.fullName}/pages/builds/${String(id)}`,
    status: 'built',
    error: { message: null },
    pusher: simpleUser(await accountOf(ctx.sql, ctx.tenant, build.pusher)),
    commit: build.commit,
    duration: 0,
    created_at: REPO_DATE,
    updated_at: REPO_DATE,
  }
}

// Newest first, as GitHub lists them, paged before any build is rendered.
async function listBuilds(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const site = siteOf(repo)
  if (site === null) return noBuild('list-apiname-pages-builds')
  const builds = site.builds ?? []
  const page = paged(ctx, builds.map((build, at) => ({ build, id: at + 1 })).reverse())
  if (page === null) return fail(422, 'Validation Failed')
  const items: JsonValue[] = []
  for (const { build, id } of page.items) items.push(await buildJson(ctx, repo, build, id))
  return { status: 200, body: items, headers: page.headers }
}

// A requested build runs at once, but the request answers as GitHub's does,
// queued, pointing at the latest build.
async function requestBuild(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const site = siteOf(repo)
  if (site === null) return noBuild('request-a-apiname-pages-build')
  await storeSite(ctx.sql, ctx.tenant, repo, await built(ctx.sql, ctx.tenant, repo, site))
  return {
    status: 201,
    body: {
      url: `https://api.github.com/repos/${repo.fullName}/pages/builds/latest`,
      status: 'queued',
    },
  }
}

async function latestBuild(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const builds = siteOf(repo)?.builds ?? []
  const build = builds.at(-1)
  if (build === undefined) return noBuild('get-latest-pages-build')
  return { status: 200, body: await buildJson(ctx, repo, build, builds.length) }
}

async function oneBuild(ctx: Ctx<C>, repo: RepoRow): Promise<Reply> {
  const raw = param(ctx, 'id')
  const id = /^\d+$/.test(raw) ? Number(raw) : 0
  const build = (siteOf(repo)?.builds ?? [])[id - 1]
  if (build === undefined) return noBuild('get-apiname-pages-build')
  return { status: 200, body: await buildJson(ctx, repo, build, id) }
}

export function pageRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => {
    const pages = `${p}/repos/:owner/:repo/pages`
    return [
      route<C>('GET', pages, authedRoute(withRepo(getSite))),
      route<C>('POST', pages, authedRoute(withRepo(createSite)), { write: true }),
      route<C>('PUT', pages, authedRoute(withRepo(updateSite)), { write: true }),
      route<C>('DELETE', pages, authedRoute(withRepo(deleteSite)), { write: true }),
      route<C>('GET', `${pages}/builds`, authedRoute(withRepo(listBuilds))),
      route<C>('POST', `${pages}/builds`, authedRoute(withRepo(requestBuild)), { write: true }),
      route<C>('GET', `${pages}/builds/latest`, authedRoute(withRepo(latestBuild))),
      route<C>('GET', `${pages}/builds/:id`, authedRoute(withRepo(oneBuild))),
    ]
  })
}
