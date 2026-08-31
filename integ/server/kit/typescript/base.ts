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

import { Clock } from './clock.ts'
import { Minter } from './mint.ts'
import { ClientPool } from './db.ts'
import type { ClientCtor, MinimalClient } from './db.ts'
import type { KitConfig } from './config.ts'
import type { Dmmf } from './seed.ts'
import type { KitRoute } from './route.ts'
import type { JsonValue, MintSharing, Reply, ResetResponse } from './types.ts'

// What a service implements. Everything else in the kit is machinery around
// these five members: there is no base class to extend and no lifecycle to
// override, because a fake that can only declare things cannot drift from the
// others in how it resets, tenants, seeds or serializes.
export interface Fake<C extends MinimalClient> {
  config: KitConfig
  client: ClientCtor<C>
  dmmf: Dmmf
  routes: () => KitRoute<C>[]
  // Fixture-shape hooks, both optional. `seedRoots` maps a top-level fixture
  // key to a model name for the cases the plural derivation cannot reach.
  // `afterSeed` runs once per seeded tenant, for state a fixture cannot state
  // (a mint counter primed past the fixture's own ids, say).
  seedRoots?: Record<string, string>
  // `fixtureRoot` is passed rather than imported, because `--fixture-root`
  // moves it: a fake that expands a `sourceDir` into file rows (github, hf_hub)
  // has to read the tree under the root this SERVER was launched with, and a
  // module constant would keep reading the checkout's own.
  // `epoch` is the reset's own, and it is passed for the same reason
  // `fixtureRoot` is: a fake whose seed WRITES a timestamp (gws stamps a
  // createdTime on every row it seeds through the Drive table) has to stamp
  // the one this reset asked for. It participates in the template key, so two
  // epochs are two templates rather than one carrying the first caller's
  // clock.
  afterSeed?: (
    db: C,
    tenant: string,
    counts: Record<string, number>,
    extras: Record<string, JsonValue>,
    fixtureRoot: string,
    epoch: string | undefined,
  ) => Promise<void>
  defaultTenants?: string[]
  // How this fake refuses a tenant it was never seeded with, and by being
  // present, THAT it refuses one at all. Declaring it is opt-in for the same
  // reason tenantFromBearer is: what an unseeded tenant means is the vendor's
  // question, not the kit's. Notion hands an integration one workspace that
  // has to exist, so an unknown one is a bad token. Dropbox mints an account
  // per mount and never resets it, so an unseeded tenant there is an ordinary
  // EMPTY account and refusing it broke every dropbox case. A fake that says
  // nothing keeps serving unseeded tenants, which is what it did before.
  unknownTenant?: (tenant: string) => Reply
}

// Per-TENANT mutable state. These were per-run until /reset learned to scope
// itself, and the move is not cosmetic: a second host resetting its own tenant
// called `minter.reset()` on the counters the first host was still minting
// from, so that host's next id repeated one it had already handed out, and
// `clock.setEpoch()` rebased its timestamps backwards mid-run. A tenant is one
// caller's whole world, so its clock and its minter are its own.
export interface TenantState {
  clock: Clock
  minter: Minter
}

// Per-run mutable state: the tenants living in one SQLite file. A run is still
// a whole isolated world, so two runs served by one process never advance each
// other's ids; this is now that guarantee one level finer.
export class RunState {
  private readonly tenants = new Map<string, TenantState>()
  // The tenants this run has actually been seeded with, which `tenants` alone
  // cannot answer: `of` mints state for ANY legal name on first sight, so a
  // tenant nobody seeded is indistinguishable from a seeded one until the
  // fake's first query comes back empty. Only `reset` records here.
  private readonly seeded = new Set<string>()
  private readonly sharing: MintSharing
  private readonly format: string

  constructor(sharing: MintSharing, format: string) {
    this.sharing = sharing
    this.format = format
  }

  of(tenant: string): TenantState {
    const live = this.tenants.get(tenant)
    if (live !== undefined) return live
    const made = {
      clock: new Clock(),
      minter: new Minter(this.sharing, this.format),
    }
    this.tenants.set(tenant, made)
    return made
  }

  // Starting a reset UNMARKS the tenant, and only markSeeded re-marks it. The
  // two are separate because a reset that throws half way through leaves a
  // world that is partly the old fixture and partly nothing: marking here
  // would serve that as valid, and never unmarking would serve a failed
  // RESEED of an already-good tenant the same way.
  reset(tenant: string, epoch?: string): void {
    const st = this.of(tenant)
    st.clock.setEpoch(epoch)
    st.minter.reset()
    this.seeded.delete(tenant)
  }

  markSeeded(tenant: string): void {
    this.seeded.add(tenant)
  }

  isSeeded(tenant: string): boolean {
    return this.seeded.has(tenant)
  }
}

export interface Runtime<C extends MinimalClient> {
  fake: Fake<C>
  pool: ClientPool<C>
  fixtureRoot: string
  state: (run: string) => RunState
  reset: (body: JsonValue) => Promise<ResetResponse>
  dispose: () => Promise<void>
}

export function makeState<C extends MinimalClient>(fake: Fake<C>): RunState {
  return new RunState(fake.config.mintSharing, fake.config.mintFormat)
}

export function makePool<C extends MinimalClient>(fake: Fake<C>): ClientPool<C> {
  return new ClientPool<C>({
    service: fake.config.service,
    schema: fake.config.schema,
    ctor: fake.client,
  })
}
