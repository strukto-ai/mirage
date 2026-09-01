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

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

import type { AWSSMConfig } from './config.ts'

/**
 * Shape one `SecretString` into secret fields.
 *
 * A JSON object with all-string values is the fields as-is (the common
 * Secrets Manager layout); anything else -- a plain string, a JSON
 * list, an object with non-string values -- is the whole text under
 * `value`.
 */
export function fieldsFromSecretString(text: string): Record<string, string> {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return { value: text }
  }
  if (
    decoded !== null &&
    typeof decoded === 'object' &&
    !Array.isArray(decoded) &&
    Object.values(decoded).every((value) => typeof value === 'string')
  ) {
    return decoded as Record<string, string>
  }
  return { value: text }
}

/**
 * Fetch one secret from AWS Secrets Manager.
 *
 * `ref` is the `SecretId` -- a secret name or full ARN. The SDK loads
 * on first use (the lazy-module trick Python spells as an import
 * path), and an absent explicit credential falls to the SDK's default
 * provider chain, so an empty config reads the ambient AWS settings.
 * A binary secret is refused: v1 reads `SecretString` only.
 */
export async function fetchAwsSm(config: AWSSMConfig, ref: string): Promise<ResolvedSecret> {
  if (ref === '') {
    throw new SecretsError("the 'aws-sm' source needs a ref: the SecretId (name or ARN)")
  }
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient({
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.awsProfile !== undefined ? { profile: config.awsProfile } : {}),
    ...(config.awsAccessKeyId !== undefined && config.awsSecretAccessKey !== undefined
      ? {
          credentials: {
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
            ...(config.awsSessionToken !== undefined
              ? { sessionToken: config.awsSessionToken }
              : {}),
          },
        }
      : {}),
  })
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: ref }))
    const text = response.SecretString
    if (text === undefined) {
      throw new SecretsError(`secret '${ref}' is binary (SecretBinary); v1 reads SecretString only`)
    }
    return { fields: fieldsFromSecretString(text) }
  } finally {
    client.destroy()
  }
}
