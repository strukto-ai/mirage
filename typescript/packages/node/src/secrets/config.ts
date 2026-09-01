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
// (see resource/secrets.ts), which still type-checks but takes minutes
// and defeats the registry's nominal ZodType pairing.
import { z } from '@struktoai/mirage-core/resource/secrets'

/**
 * AWS Secrets Manager source config: the five AWS credential fields
 * every AWS-speaking config shares, nothing else. Python factors them
 * into an `AWSAuth` base its `S3Config` also extends; here the s3
 * config owns its snake_case normalizer, so the shape serves this
 * source alone. The `ref` of a managed entry is the SecretId; it rides
 * the fetch call, not this config.
 */
const AWS_SM_KEYS: Readonly<Record<string, string>> = {
  aws_access_key_id: 'awsAccessKeyId',
  aws_secret_access_key: 'awsSecretAccessKey',
  aws_session_token: 'awsSessionToken',
  aws_profile: 'awsProfile',
}

/**
 * Accept the snake_case spellings a `secrets:` block arrives in.
 *
 * A source's config keys travel raw out of yaml, spelled python's way
 * like a mount's are, so the four prefixed AWS keys reach this schema
 * as `aws_profile` and friends. The rename lives here rather than in
 * the config door because the door would impose it on every source's
 * model, a custom one included; this one is the only builtin whose
 * fields are more than a single word. Camel keys pass through, so a
 * TS caller building the config directly is unaffected.
 */
function normalizeAwsSmKeys(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const camel = AWS_SM_KEYS[key]
    // A config carrying both spellings of one field is refused rather
    // than settled by insertion order: the snake key is left in place
    // and the strict object reports it as unrecognized. Python refuses
    // the same config from the other side, its camel key being the
    // extra one there.
    if (camel === undefined || Object.hasOwn(input, camel)) out[key] = value
    else out[camel] = value
  }
  return out
}

export const AWSSMConfig = z.preprocess(
  normalizeAwsSmKeys,
  z.strictObject({
    region: z.string().optional(),
    awsAccessKeyId: z.string().optional(),
    awsSecretAccessKey: z.string().optional(),
    awsSessionToken: z.string().optional(),
    awsProfile: z.string().optional(),
  }),
)
export type AWSSMConfig = z.infer<typeof AWSSMConfig>

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

/**
 * 1Password source config: the service account token.
 *
 * Absent, the token falls back to `OP_SERVICE_ACCOUNT_TOKEN` in the
 * host process env, the variable 1Password's own CLI and SDKs read, so
 * a deployment with one account needs no config at all -- the same
 * shape `aws-sm` has, where an empty config reads the ambient AWS
 * settings.
 */
export const OnePasswordConfig = z.strictObject({
  token: z.string().optional(),
})
export type OnePasswordConfig = z.infer<typeof OnePasswordConfig>
