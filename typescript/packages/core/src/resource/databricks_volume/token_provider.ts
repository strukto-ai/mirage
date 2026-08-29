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

/**
 * Where a Databricks bearer token comes from, per operation.
 *
 * The contract, which every implementation owes its caller:
 *
 * - `getToken` returns the raw token, without the `Bearer` prefix. It may be
 *   sync or async; mirage awaits the result either way.
 * - mirage calls it before each independent Files API operation, so one
 *   user-visible command may consult it several times. Caching, refresh and
 *   locking belong to the provider, which is the only party that knows how
 *   its credential is minted.
 * - mirage never stores, serializes or snapshots the provider or the token it
 *   returns, and never replays a request on 401: an on-behalf-of provider
 *   cannot re-mint a user's token, and a write must not be sent twice. A 401
 *   surfaces as `DatabricksVolumeApiError`.
 */
export interface TokenProvider {
  getToken(): string | Promise<string>
}

/**
 * A provider for one long-lived token, e.g. a personal access token.
 *
 * The only provider mirage ships. Anything that mints, refreshes or exchanges
 * a credential (OAuth M2M, on-behalf-of, a CLI profile) is application code:
 * it implements `TokenProvider` and keeps its own dependencies, which is why
 * mirage needs none of its own.
 */
export class StaticTokenProvider implements TokenProvider {
  private readonly token: string

  constructor(token: string) {
    this.token = token
  }

  getToken(): string {
    return this.token
  }
}
