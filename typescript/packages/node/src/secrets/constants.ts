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

import { createRequire } from 'node:module'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'

import { AWSSMConfig, DotenvConfig, EnvConfig, OnePasswordConfig } from './config.ts'

// Resolution only, never a load: this answers whether an optional
// peer is installed without pulling it in. `import.meta.resolve` would
// be the obvious tool and is unusable -- vitest's SSR transform leaves
// it undefined, so the probe would report every peer missing under
// test and in any bundler that does the same.
const resolvePeer = createRequire(import.meta.url).resolve

/**
 * Refuse a source whose optional peer dependency is not installed.
 *
 * Synchronous, so it answers where the workspace is built rather than
 * on the first line that reads a secret.
 */
function requirePeer(source: string, peer: string): void {
  try {
    resolvePeer(peer)
  } catch {
    throw new SecretsError(
      `the '${source}' source needs its optional dependency (${peer}): npm install ${peer}`,
    )
  }
}

/** The builtin source names this module registers, sorted. */
export const BUILTIN_SOURCE_NAMES = ['1password', 'aws-sm', 'dotenv', 'env'] as const

// Builtin fetchers load lazily: each registered fetch dynamically
// imports its module on first use, so a source's SDK loads only when a
// workspace actually uses it (Python spells the same table as import
// paths beside its core registry). Registration itself runs at import
// time -- the compression-codec pattern -- because core's registry
// cannot name node modules; the node Workspace and the config door both
// import this module, so either entry point arms the builtins.
registerSecrets('env', EnvConfig, async (config, ref) =>
  (await import('./env.ts')).fetchEnv(config, ref),
)
registerSecrets('dotenv', DotenvConfig, async (config, ref) =>
  (await import('./dotenv.ts')).fetchDotenv(config, ref),
)
registerSecrets('aws-sm', AWSSMConfig, async (config, ref) =>
  (await import('./aws.ts')).fetchAwsSm(config, ref),
)
registerSecrets(
  '1password',
  OnePasswordConfig,
  async (config, ref) => (await import('./onepassword.ts')).fetchOnePassword(config, ref),
  // The SDK still loads lazily; this only asks the resolver whether it
  // is installed, so a workspace that declares the source learns at
  // construction and one that does not pays nothing. Python's own
  // check is its `source_for` resolving an import path.
  () => {
    requirePeer('1password', '@1password/sdk')
  },
)
