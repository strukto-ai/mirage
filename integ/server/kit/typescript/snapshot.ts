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

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { RunState } from './base.ts'
import type { ClockState } from './clock.ts'
import { FaultError, FixtureError, SnapshotError, TenantError } from './errors.ts'
import { parseFaultBody } from './fault.ts'
import type { FaultPlan } from './fault.ts'
import { fixturePath } from './fixture.ts'
import { checkName } from './tenant.ts'
import type { JsonValue } from './types.ts'

const SQLITE = Buffer.from('SQLite format 3\0', 'latin1')
const FIELDS = ['db', 'fixture', 'schema', 'service', 'tenants']
const TENANT_FIELDS = ['clock', 'counters', 'faults', 'seeded']

// One tenant of a run's snapshot: whether a reset seeded it, its clock, its
// id counters (by kind, '' for a global one) and its armed fault plans as
// POST /_kit/faults takes them, with how many requests each has served.
export type TenantSnapshot = {
  seeded: boolean
  clock: { base_ms: number; ticks: number }
  counters: Record<string, number>
  faults: { plans: JsonValue[]; served: number[] }
}

// A run's world, as GET /_kit/runs/<run>/snapshot answers it and POST
// /_kit/runs/<run>/load takes it back: the run's SQLite file whole (base64),
// the state each tenant keeps beside it, and the fixture a bare /reset of the
// run would reseed from. `service` and `schema` (the digest of the fake's
// Prisma schema) name what can load it, so a snapshot of another fake, or of
// this one before its schema changed, is refused rather than served wrong.
export type RunSnapshot = {
  service: string
  schema: string
  fixture: string
  tenants: Record<string, TenantSnapshot>
  db: string
}

export interface LoadedTenant {
  seeded: boolean
  clock: ClockState
  counters: Record<string, number>
  plans: FaultPlan[]
  served: number[]
}

export interface LoadedSnapshot {
  fixture: string
  tenants: Map<string, LoadedTenant>
  db: Buffer
}

export function schemaDigest(schema: string): string {
  return createHash('sha256').update(readFileSync(schema)).digest('hex')
}

export function snapshotOf(
  service: string,
  schema: string,
  fixture: string,
  state: RunState,
  db: Buffer,
): RunSnapshot {
  const tenants: Record<string, TenantSnapshot> = {}
  for (const tenant of state.names()) {
    const st = state.of(tenant)
    const clock = st.clock.snapshot()
    tenants[tenant] = {
      seeded: state.isSeeded(tenant),
      clock: { base_ms: clock.baseMs, ticks: clock.ticks },
      counters: st.minter.snapshot(),
      faults: st.faults.snapshot(),
    }
  }
  return { service, schema, fixture, tenants, db: db.toString('base64') }
}

function isObject(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exactly(
  v: JsonValue | undefined,
  fields: string[],
  what: string,
): Record<string, JsonValue> {
  if (!isObject(v)) throw new SnapshotError(`${what} must be a JSON object`)
  const keys = Object.keys(v).sort()
  if (keys.join() !== fields.join()) {
    throw new SnapshotError(`${what} has fields ${keys.join(', ')}, not ${fields.join(', ')}`)
  }
  return v
}

function count(v: JsonValue | undefined, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) {
    throw new SnapshotError(`${what} must be an integer in [0, ${String(max)}]`)
  }
  return v
}

function tenantOf(
  raw: JsonValue | undefined,
  what: string,
  declares: (method: string, route: string) => boolean,
): LoadedTenant {
  const t = exactly(raw, TENANT_FIELDS, what)
  if (typeof t.seeded !== 'boolean') throw new SnapshotError(`${what} seeded must be a boolean`)
  const clock = exactly(t.clock, ['base_ms', 'ticks'], `${what} clock`)
  if (typeof clock.base_ms !== 'number' || !Number.isFinite(clock.base_ms)) {
    throw new SnapshotError(`${what} clock base_ms must be a number`)
  }
  if (!isObject(t.counters)) throw new SnapshotError(`${what} counters must be a JSON object`)
  const counters = Object.fromEntries(
    Object.entries(t.counters).map(([kind, n]) => [kind, count(n, `${what} counter ${kind}`)]),
  )
  const faults = exactly(t.faults, ['plans', 'served'], `${what} faults`)
  let plans: FaultPlan[]
  try {
    plans = parseFaultBody({ plans: faults.plans ?? null }, declares)
  } catch (err: unknown) {
    if (err instanceof FaultError) throw new SnapshotError(`${what} faults: ${err.message}`)
    throw err
  }
  if (!Array.isArray(faults.served) || faults.served.length !== plans.length) {
    throw new SnapshotError(`${what} faults served must list one count per plan`)
  }
  const served = faults.served.map((n, i) =>
    count(n, `${what} faults served`, plans[i]?.times ?? 0),
  )
  return {
    seeded: t.seeded,
    clock: { baseMs: clock.base_ms, ticks: count(clock.ticks, `${what} clock ticks`) },
    counters,
    plans,
    served,
  }
}

// The whole snapshot is checked before a load touches the run, so a refused
// one leaves the run as it was.
export function parseSnapshot(
  raw: JsonValue,
  service: string,
  schema: string,
  declares: (method: string, route: string) => boolean,
): LoadedSnapshot {
  const s = exactly(raw, FIELDS, 'a snapshot')
  if (s.service !== service) {
    throw new SnapshotError(`a snapshot of the ${String(s.service)} fake, not ${service}`)
  }
  if (s.schema !== schema) {
    throw new SnapshotError(`a snapshot of another ${service} schema`)
  }
  // Checked now as /reset checks a name, since a bare reset of the loaded run
  // reseeds from it.
  if (typeof s.fixture !== 'string') throw new SnapshotError('a snapshot fixture must be a name')
  try {
    fixturePath(service, s.fixture)
  } catch (err: unknown) {
    if (err instanceof FixtureError) throw new SnapshotError(`a snapshot ${err.message}`)
    throw err
  }
  if (typeof s.db !== 'string') throw new SnapshotError('a snapshot db must be base64')
  const db = Buffer.from(s.db, 'base64')
  if (!db.subarray(0, SQLITE.length).equals(SQLITE)) {
    throw new SnapshotError('a snapshot db is not a SQLite database')
  }
  if (!isObject(s.tenants)) throw new SnapshotError('a snapshot tenants must be a JSON object')
  const tenants = new Map<string, LoadedTenant>()
  for (const [name, raw] of Object.entries(s.tenants)) {
    try {
      checkName('tenant', name)
    } catch (err: unknown) {
      if (err instanceof TenantError) throw new SnapshotError(`a snapshot tenant: ${err.message}`)
      throw err
    }
    tenants.set(name, tenantOf(raw, `tenant ${name}`, declares))
  }
  return { fixture: s.fixture, tenants, db }
}

// A loaded run's state: each tenant's clock, counters and plans as the
// snapshot had them, and the seeded ones marked.
export function loadState(state: RunState, tenants: Map<string, LoadedTenant>): void {
  for (const [name, tenant] of tenants) {
    const st = state.of(name)
    st.clock.load(tenant.clock)
    st.minter.load(tenant.counters)
    st.faults.load(tenant.plans, tenant.served)
    if (tenant.seeded) state.markSeeded(name)
  }
}
