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

import type { C } from './client.ts'
import type { GwsState } from './state.ts'

// One tenant's loaded world, kept between requests, because `loadState` reads
// 25 tables to rebuild what the previous request already had in hand. Measured
// across the five core-facet gws targets: 123s of loadState against 1.0s of
// handler work.
//
// Two boundaries make it safe. Only `wire/route.ts` reads through here, so
// `loadState` and `saveState` stay pure functions of the rows and the seed
// path still reads the file -- `afterSeed` runs against a tenant the kit has
// just cleared, and answering that from a cached world would hand the reset
// back what it was replacing. And the key is the run's CLIENT, not its name,
// so a closed or recreated run loses its world with no eviction hook, and two
// Runtimes in one process cannot reach each other's worlds even when they name
// the same run and tenant.
interface Cached {
  world: GwsState | undefined
  // Bumped by every drop, and by a write installing what it flushed.
  //
  // A read does not join the run's write queue (`Router.run`), so one that
  // misses can still be inside `loadState` when a /reset drops this entry, or
  // when a write that missed alongside it flushes its own copy. Installing
  // what it read would put an older world over a newer one -- and since the
  // next write flushes whatever is cached, those newer rows would be erased
  // from SQLite too. The request still answers from its own snapshot, as every
  // request did before this cache; what must not happen is that snapshot
  // outliving the request.
  generation: number
}

const WORLDS = new WeakMap<C, Map<string, Cached>>()

function entry(db: C, tenant: string): Cached {
  let live = WORLDS.get(db)
  if (live === undefined) {
    live = new Map()
    WORLDS.set(db, live)
  }
  let row = live.get(tenant)
  if (row === undefined) {
    row = { world: undefined, generation: 0 }
    live.set(tenant, row)
  }
  return row
}

// Inverted rather than a get/load/put the caller sequences itself, because the
// ordering IS the guard: a caller that read the generation after its load
// would compile and silently reinstall a stale world.
export async function withState(
  db: C,
  tenant: string,
  load: () => Promise<GwsState>,
): Promise<GwsState> {
  const row = entry(db, tenant)
  if (row.world !== undefined) return row.world
  const began = row.generation
  const world = await load()
  if (row.generation === began) row.world = world
  return world
}

export function installFlushed(db: C, tenant: string, st: GwsState): void {
  const row = entry(db, tenant)
  row.world = st
  row.generation += 1
}

// No entry means no load can be in flight for it: `withState` registers one
// synchronously, before the await it races against.
export function dropState(db: C, tenant: string): void {
  const row = WORLDS.get(db)?.get(tenant)
  if (row === undefined) return
  row.world = undefined
  row.generation += 1
}

export function dropTenants(db: C, tenants: readonly string[]): void {
  for (const tenant of tenants) dropState(db, tenant)
}

// The selftest's window onto what a request would be handed. No route reads it.
export function cachedState(db: C, tenant: string): GwsState | undefined {
  return WORLDS.get(db)?.get(tenant)?.world
}
