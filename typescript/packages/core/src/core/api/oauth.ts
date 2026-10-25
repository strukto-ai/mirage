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

import { isSystemClock, SystemClock, type Clock } from '../../utils/clock.ts'

/**
 * Caches a short-lived access token, refreshing before expiry.
 *
 * Subclasses implement `refreshPair` with their provider's grant. An
 * in-flight refresh is shared so concurrent callers cost one round-trip,
 * and `bufferSeconds` refreshes early so a token never expires
 * mid-request.
 *
 * Expiry is read on `clock`, which also times the waits between retries of
 * the calls the manager signs. A mount hands it the workspace's clock
 * through `bindClock` and gives it back through `releaseClock`; absent is
 * the system clock.
 */
export abstract class TokenManager {
  private accessToken: string | null = null
  private expiresAt = 0
  private inflight: Promise<string> | null = null
  private readonly bufferSeconds: number
  clock: Clock
  private readonly holders = new Set<unknown>()

  constructor(bufferSeconds = 300, clock?: Clock) {
    this.bufferSeconds = bufferSeconds
    this.clock = clock ?? new SystemClock()
  }

  /**
   * Read expiry and time retry waits on `clock` while `owner` holds the
   * manager. A workspace holds it from the moment its mounts take its clock
   * until it unmounts the VFS or closes; holding again, or letting go twice,
   * changes nothing. Expiry and waits can follow one clock only, so while
   * another owner holds the manager a different clock is refused; two system
   * clocks agree. A refreshed token's expiry was read on the clock it
   * replaces, so it is dropped and the next call refreshes; a seeded token
   * that never expires is kept.
   *
   * @param owner who holds it, released by the same key.
   * @throws Error when another owner holds the manager on another clock.
   */
  bindClock(clock: Clock, owner: unknown): void {
    const same = clock === this.clock || (isSystemClock(clock) && isSystemClock(this.clock))
    if (!same) {
      if ([...this.holders].some((held) => held !== owner)) {
        throw new Error(
          'this client is held by a workspace on another clock; ' +
            'unmount or uninstall it there, or give both one clock',
        )
      }
      this.clock = clock
      if (this.expiresAt !== Number.POSITIVE_INFINITY) this.expiresAt = 0
    }
    this.holders.add(owner)
  }

  /** Let `owner` go; once none holds, another clock may bind. */
  releaseClock(owner: unknown): void {
    this.holders.delete(owner)
  }

  /** Fetch a fresh token as `[accessToken, expiresInSeconds]`. */
  protected abstract refreshPair(): Promise<[string, number]>

  /**
   * Preload the cache with a token minted outside the refresh flow.
   * `expiresAt` is epoch seconds after which `getToken` refreshes again;
   * pass `Number.POSITIVE_INFINITY` for a token the manager can never
   * replace itself.
   */
  protected seed(token: string, expiresAt: number): void {
    this.accessToken = token
    this.expiresAt = expiresAt
  }

  async getToken(): Promise<string> {
    if (this.accessToken !== null && this.clock.now() < this.expiresAt) {
      return this.accessToken
    }
    if (this.inflight !== null) return this.inflight
    const p = this.refresh()
    this.inflight = p
    try {
      return await p
    } finally {
      this.inflight = null
    }
  }

  private async refresh(): Promise<string> {
    const [token, expiresIn] = await this.refreshPair()
    this.accessToken = token
    this.expiresAt = this.clock.now() + expiresIn - this.bufferSeconds
    return token
  }
}
