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

// Through core's re-export, never a direct 'zod' import: a second zod
// instance makes every ZodObject here structurally unrelated to core's
// (see VFS/secrets.ts), which still type-checks but takes minutes
// and defeats the registry's nominal ZodType pairing.
import { z } from '@struktoai/mirage-core/vfs/secrets'

// The AWS and 1Password configs are core's, shared with the runtimes
// that read those stores without their SDKs' node installs.
export { AWSSMConfig, OnePasswordConfig } from '@struktoai/mirage-core/secrets/config'

/**
 * Dotenv source config: `path` is the default file when a managed
 * entry's `ref` is empty; a non-empty `ref` is itself the host
 * filesystem path.
 */
export const DotenvConfig = z.strictObject({
  path: z.string().default('.env'),
})
export type DotenvConfig = z.infer<typeof DotenvConfig>

/**
 * Process-environment source config: there is nothing to say. The host
 * process env has no sub-address, so a managed entry using this source
 * must leave `ref` empty.
 */
export const EnvConfig = z.strictObject({})
export type EnvConfig = z.infer<typeof EnvConfig>
