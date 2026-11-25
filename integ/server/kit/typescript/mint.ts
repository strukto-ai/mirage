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

import type { MintSharing } from './types.ts'

// Every fake reinvented this: 22 nextId(, 22 _seq, 5 postSeq, 4 _counter.
// Sharing decides whether one counter serves all kinds (linear's single
// _counter, where a create of one kind still advances the next) or each kind
// counts alone (gws's per-kind counters).
export class Minter {
  private counters = new Map<string, number>()
  private readonly sharing: MintSharing
  private readonly format: string

  constructor(sharing: MintSharing = 'global', format = '{kind}_new_{n}') {
    this.sharing = sharing
    this.format = format
  }

  next(kind: string): number {
    const key = this.sharing === 'global' ? '' : kind
    const n = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, n)
    return n
  }

  mint(kind: string): string {
    return this.format.replace('{kind}', kind).replace('{n}', String(this.next(kind)))
  }

  reset(): void {
    this.counters.clear()
  }

  // Each counter by its key ('' for a global one), as a run's snapshot keeps
  // them, so a loaded run mints the id the snapshotted one would have next.
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters)
  }

  load(counters: Record<string, number>): void {
    this.counters = new Map(Object.entries(counters))
  }
}
