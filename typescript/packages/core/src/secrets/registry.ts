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

import type { z } from 'zod'

import { compareCodePoints } from '../utils/sort.ts'
import { SecretsError } from './errors.ts'
import type { ResolvedSecret, ResolvedSource, SecretFetchFn } from './types.ts'

/** One resolvable source: its config model and its fetch function. */
export interface SourceEntry {
  readonly configModel: z.ZodType
  readonly fetch: SecretFetchFn
  /**
   * Throws when the source's optional dependency is absent, and is
   * called by `sourceFor` -- so a declaration naming a source whose
   * SDK is not installed fails where the workspace is built, with the
   * package to install, rather than as a redacted fetch failure on the
   * first line that reads a secret. Python gets this for free: its
   * `sourceFor` resolves an import path, so the ModuleNotFoundError is
   * the check. A dynamic import here is async and construction is
   * not, hence a synchronous probe the source supplies.
   */
  readonly requirePeer?: () => void
}

// One registry, populated by registerSecrets. Python's core registry
// hardwires its builtin table beside this; here the builtins live in
// the node package (they read process state and load SDKs core cannot
// name), registered on import the way compression codecs are.
const REGISTERED = new Map<string, SourceEntry>()

/**
 * Register a secrets source under a name.
 *
 * Host-side only, like `registerCli`: the embedding program calls it,
 * never a line the agent types. A source is one config model plus one
 * async function; there is no Provider class. Registering an existing
 * name replaces it, builtins included -- the host owns both sides of
 * this registry, so shadowing `env` is a deployment decision, not an
 * escalation.
 */
export function registerSecrets<C>(
  name: string,
  configModel: z.ZodType<C>,
  fetch: SecretFetchFn<C>,
  requirePeer?: () => void,
): void {
  REGISTERED.set(name, {
    configModel,
    fetch,
    ...(requirePeer !== undefined ? { requirePeer } : {}),
  })
}

/** Every name `sourceFor` can resolve. */
export function knownSources(): string[] {
  return [...REGISTERED.keys()].sort(compareCodePoints)
}

/**
 * Resolve a source name to its config model and fetch function.
 *
 * Throws SecretsError when `name` is not registered. The node package
 * registers the builtin sources (`env`, `dotenv`, `aws-sm`) on import;
 * a browser workspace resolves only what its embedder registered.
 */
export function sourceFor(name: string): SourceEntry {
  const entry = REGISTERED.get(name)
  if (entry === undefined) {
    throw new SecretsError(
      `unknown secrets source '${name}'; known: [${knownSources().join(', ')}]`,
    )
  }
  entry.requirePeer?.()
  return entry
}

/**
 * Fetch one secret from a named source.
 *
 * The whole call path: resolve the source, take its config, run its
 * fetch. Pure and module-level -- there is no resolver class, and no
 * cache: fetched values live only on session vars.
 *
 * `source` names a declared instance first and a source second, so a
 * deployment with one account of a platform can leave the `secrets:`
 * block out entirely and still spell `from: aws-sm`. An undeclared
 * name builds its config from ambient defaults, which is what every
 * source did before the block existed.
 */
export async function fetchSecret(
  source: string,
  ref: string,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<ResolvedSecret> {
  // Own properties only, which is what Python's dict lookup does: a
  // plain object answers `sources['constructor']` with a prototype
  // member, and an undeclared source named after one would reach
  // `.fetch` on it instead of falling through to the registry.
  const entry =
    sources !== undefined && Object.hasOwn(sources, source) ? sources[source] : undefined
  if (entry !== undefined) return entry.fetch(entry.config as never, ref)
  const { configModel, fetch } = sourceFor(source)
  return fetch(configModel.parse({}) as never, ref)
}
