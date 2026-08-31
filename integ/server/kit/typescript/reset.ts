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

import { clearTenants } from './clear.ts'
import { ResetBodyError } from './errors.ts'
import { DEFAULT_FIXTURE, DEFAULT_FIXTURE_ROOT, loadFixture } from './fixture.ts'
import { seedFixture } from './seed.ts'
import { checkName, DEFAULT_RUN, DEFAULT_TENANT } from './tenant.ts'
import type { MinimalClient } from './db.ts'
import type { Fake, RunState } from './base.ts'
import type { ClientPool } from './db.ts'
import type { JsonValue, ResetRequest, ResetResponse, SeedReport } from './types.ts'

const KNOWN = new Set(['run', 'epoch', 'tenants', 'fixture', 'extras'])

// One body shape and one response shape, replacing five incompatible ones on
// the same path. Every field but `run` is optional, and an unknown field
// is refused rather than ignored: a host that sends `workspace` where the kit
// wants `tenants` must fail loudly at the door, not silently reset the wrong
// thing and then disagree with the other host.
export function parseResetBody(
  raw: JsonValue,
  fallbackTenants: string[],
  fallbackFixture: string = DEFAULT_FIXTURE,
): ResetRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ResetBodyError('reset body must be a JSON object')
  }
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k))
  if (unknown.length > 0) {
    throw new ResetBodyError(`unknown /reset fields: ${unknown.sort().join(', ')}`)
  }
  const run = raw.run === undefined ? DEFAULT_RUN : raw.run
  if (typeof run !== 'string') throw new ResetBodyError('/reset run must be a string')
  const epoch = raw.epoch
  if (epoch !== undefined && typeof epoch !== 'string') {
    throw new ResetBodyError('/reset epoch must be an ISO string')
  }
  const tenantsRaw = raw.tenants
  let tenants: string[]
  if (tenantsRaw === undefined) {
    tenants = fallbackTenants
  } else if (Array.isArray(tenantsRaw) && tenantsRaw.every((s) => typeof s === 'string')) {
    tenants = tenantsRaw
  } else {
    throw new ResetBodyError('/reset tenants must be a list of strings')
  }
  if (tenants.length === 0) throw new ResetBodyError('/reset tenants must not be empty')
  const fixture = raw.fixture === undefined ? fallbackFixture : raw.fixture
  if (typeof fixture !== 'string') throw new ResetBodyError('/reset fixture must be a name')
  const extras = raw.extras
  if (
    extras !== undefined &&
    (typeof extras !== 'object' || extras === null || Array.isArray(extras))
  ) {
    throw new ResetBodyError('/reset extras must be an object')
  }
  const out: ResetRequest = {
    run: checkName('run', run),
    tenants: tenants.map((s) => checkName('tenant', s)),
    fixture,
    extras: extras === undefined ? {} : extras,
  }
  if (epoch !== undefined) out.epoch = epoch
  return out
}

// A reset is SCOPED whenever the tenant is a column, and that is what lets two
// hosts share one server. Recreating the run file is correct for one caller and
// destructive for two: both hosts land on run `default` (no adapter sends one),
// so the second host's /reset unlinked the database the first was reading and
// every later request on that run failed forever. With a tenant column the same
// reset is expressible as a delete restricted to the named tenants, which
// leaves the other host's rows, clock and counters untouched.
//
// A fake with no tenant column has nothing to restrict by, so it keeps
// recreating the file. That is not a gap: `tenantKind: 'none'` means one world
// per run, and recreating it IS the scoped reset for a single tenant.
export async function applyReset<C extends MinimalClient>(
  fake: Fake<C>,
  pool: ClientPool<C>,
  state: (run: string) => RunState,
  req: ResetRequest,
  fixtureRoot: string = DEFAULT_FIXTURE_ROOT,
): Promise<ResetResponse> {
  // The fixture is read BEFORE anything is destroyed. An unreadable name is a
  // 400, and answering one after having already deleted the caller's rows
  // leaves them with neither their data nor the seed they asked for. It did
  // not matter when a reset recreated the whole file, because that file was
  // gone either way; it matters now that a reset is a delete.
  const fixture = loadFixture(fake.config.service, req.fixture, fixtureRoot)
  const scoped = fake.config.tenantKind !== 'none'
  // A run that does not exist yet can be COPIED into being from a template
  // that is already seeded, which is the difference between a file copy and a
  // full seed (github's v1 measures ~175ms against ~1ms). It is only sound
  // because seeding is deterministic: seedFixture reads the fixture and
  // nothing else, and every input that CAN vary is in the key below. An
  // existing run still clears and reseeds, since replacing its file would
  // destroy the tenants this reset did not name.
  const fresh = !pool.has(req.run)
  // `onSeeded` is how the caller marks progress, and the template build passes
  // none: it seeds a THROWAWAY database, so marking this run's tenants there
  // would claim a world that the copy has not made yet.
  const seedInto = async (into: C, onSeeded?: (tenant: string) => void): Promise<SeedReport[]> => {
    const out: SeedReport[] = []
    for (const tenant of req.tenants) {
      const rows = await seedFixture(into, fixture, {
        dmmf: fake.dmmf,
        tenant,
        tenantKind: fake.config.tenantKind,
        ...(fake.seedRoots === undefined ? {} : { roots: fake.seedRoots }),
      })
      if (fake.afterSeed !== undefined) {
        await fake.afterSeed(into, tenant, rows, req.extras, fixtureRoot, req.epoch)
      }
      out.push({ tenant, rows })
      onSeeded?.(tenant)
    }
    return out
  }
  if (scoped && fresh) {
    const template = await pool.seededTemplate(templateKey(req), seedInto)
    pool.clientFromSeeded(req.run, template)
    const st = state(req.run)
    // Marked right after the copy, because the copy IS the seed here. Reached
    // only once seededTemplate has resolved, so a template build that threw
    // leaves every tenant unmarked exactly as a failed seed does.
    for (const tenant of req.tenants) {
      st.reset(tenant, req.epoch)
      st.markSeeded(tenant)
    }
    return {
      ok: true,
      run: req.run,
      epoch: req.epoch ?? null,
      scoped,
      tenants: req.tenants,
      seeded: template.rows,
    }
  }
  const db = scoped ? pool.client(req.run) : await pool.recreate(req.run)
  if (scoped) await clearTenants(db, fake.dmmf, req.tenants)
  const st = state(req.run)
  for (const tenant of req.tenants) st.reset(tenant, req.epoch)
  // Marked per tenant as each one finishes, not after the loop: a later tenant
  // throwing must not unmark the ones already seeded.
  const seeded = await seedInto(db, (tenant) => {
    st.markSeeded(tenant)
  })
  return {
    ok: true,
    run: req.run,
    epoch: req.epoch ?? null,
    scoped,
    tenants: req.tenants,
    seeded,
  }
}

// Everything a seed can depend on, and nothing else. The fixture NAME rather
// than its content because a fixture file is fixed on disk; the tenants
// because every seeded row carries the tenant column and afterSeed is handed
// the name; extras because afterSeed reads them; the epoch because afterSeed
// is handed that too and a seed that stamps it into a row would otherwise
// serve the FIRST caller's clock to every later run that shared the template.
//
// The tenants are NOT sorted. Sorting would let ['b','a'] and ['a','b'] share
// a template whose cached report is in the first caller's order, so the second
// answered `tenants: ['a','b']` beside `seeded: [b, a]` where the uncached
// path has both in request order. Two orders are two keys, which costs a
// second template in a case that does not arise and cannot disagree.
function templateKey(req: ResetRequest): string {
  return JSON.stringify([req.fixture, req.tenants, req.extras, req.epoch ?? null])
}

// A /reset reached through `/_run/<id>/reset` is about THAT run, so the prefix
// fills the body's `run` in. A body naming a DIFFERENT one is a caller
// contradicting itself, and is refused rather than silently resolved in favour
// of either. Lives here beside the rest of the body handling so gws, which
// keeps its own copy of the request flow, reaches the same rule.
export function withPathRun(body: JsonValue, pathRun: string | undefined): JsonValue {
  if (pathRun === undefined) return body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const named = (body as Record<string, JsonValue>).run
  if (named !== undefined) {
    // A non-empty string that differs is a caller contradicting itself. Every
    // other present value (a number, an empty string) is malformed, and is
    // handed on unchanged so parseResetBody refuses it in its own words
    // rather than being reported as a contradiction it is not. Overwriting it
    // turned a request that owes a 400 into a reset of somebody else's run.
    if (typeof named === 'string' && named !== '' && named !== pathRun) {
      throw new ResetBodyError(
        `/reset run ${named} contradicts the /_run/${pathRun} it was sent to`,
      )
    }
    return body
  }
  return { ...(body as Record<string, JsonValue>), run: pathRun }
}

export function defaultTenantsOf<C extends MinimalClient>(fake: Fake<C>): string[] {
  return fake.defaultTenants ?? [DEFAULT_TENANT]
}
