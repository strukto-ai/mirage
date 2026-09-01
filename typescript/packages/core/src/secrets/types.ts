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
 * What one fetch returns: a secret's fields, flat and stringly.
 *
 * `fields` are the secret's key/value pairs; an env entry's `key`
 * selects one of them. `expiresAt` is epoch seconds after which the
 * fields are stale, null when the source does not expire (all of v1's
 * sources; expiry arrives with auth0 as a per-var fact).
 */
export interface ResolvedSecret {
  readonly fields: Record<string, string>
  readonly expiresAt?: number | null
}

/**
 * One source's fetch: (its config, an opaque ref) -> the secret. Each
 * fetcher narrows the config parameter to its own model; the registry
 * pairs it with that model so the call site always hands the right one
 * (the same contract Python spells with `Any`).
 */
export type SecretFetchFn<C = never> = (config: C, ref: string) => Promise<ResolvedSecret>

/**
 * One declared instance, ready to fetch from.
 *
 * The config plane's output: the source's config parsed and its
 * pointers read, paired with the fetch that takes it. Held for the
 * workspace's lifetime, so a config value is read once rather than per
 * line, and never written anywhere a session serializes.
 */
export interface ResolvedSource {
  /**
   * The registered source this instance speaks to. Kept because an
   * instance is named by the deployment, so the instance name alone
   * cannot say whether the fields behind it are a secret's shape or
   * the host's.
   */
  readonly source: string
  readonly config: unknown
  readonly fetch: SecretFetchFn
}
