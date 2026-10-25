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

import { ReadPolicy, type ReadSpec } from '../types.ts'

/**
 * Answers a client keeps of its own service, under its mount's read policy.
 *
 * A store's search results and a database's names never pass the
 * dispatcher's cache stage, so the stage can neither bound nor drop them.
 * They are kept here instead, where the mount reaches them: `govern` keeps an
 * answer no longer than the mount's read policy lets it serve one unchecked,
 * which is not at all under `fresh` (an answer carries no token to check) and
 * within the bound under `bounded`; and the mount clears them with its own
 * caches after a write that went past the dispatcher (`Accessor.forget`).
 * Mirrors Python's `ResponseCache`.
 */
export class ResponseCache<K, V> {
  private readonly answers = new Map<K, { expires: number | null; value: V }>()
  private generation = 0

  /**
   * @param ttl seconds an answer is kept, before any mount governs it; null
   *   keeps it until cleared, 0 keeps nothing.
   */
  constructor(private ttl: number | null = null) {}

  /**
   * Keep answers no longer than a mount's read policy allows. A client
   * mounted at several prefixes keeps the strictest.
   */
  govern(read: ReadSpec): void {
    const bound = read.policy === ReadPolicy.FRESH ? 0 : read.ttl
    if (this.ttl === null || bound < this.ttl) {
      this.ttl = bound
      // Kept under the looser bound, an answer would outlive this one.
      this.clear()
    }
  }

  /**
   * The kept answer for `key`, else `fetch`'s, kept. An answer is kept for
   * the bound from when it arrives, as the file cache keeps a read from when
   * it lands, so a fetch slower than the bound is not expired as it arrives.
   */
  async get(key: K, fetch: () => Promise<V>): Promise<V> {
    if (this.ttl !== null && this.ttl <= 0) return fetch()
    const now = Date.now()
    const kept = this.answers.get(key)
    if (kept !== undefined && (kept.expires === null || now < kept.expires)) return kept.value
    const generation = this.generation
    const value = await fetch()
    // A clear while the service answered may be for the very write this
    // answer predates, so it is handed back but not kept.
    if (generation === this.generation) {
      this.answers.set(key, {
        expires: this.ttl === null ? null : Date.now() + this.ttl * 1000,
        value,
      })
    }
    return value
  }

  /** Drop every kept answer, and any answer still on its way. */
  clear(): void {
    this.generation += 1
    this.answers.clear()
  }
}
