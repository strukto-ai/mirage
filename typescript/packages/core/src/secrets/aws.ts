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

import { z } from 'zod'

import { compareCodePoints } from '../utils/sort.ts'
import { SecretsError } from './errors.ts'
import type { ResolvedSecret } from './types.ts'

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
 * the config loader because the loader would impose it on every source's
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

/** A region as AWS's endpoints spell one: `us-east-1`, `cn-north-1`. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

async function hmac(key: string | ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text))
}

/** One request to sign with AWS Signature Version 4. */
export interface SigV4Request {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly region: string
  readonly service: string
  /** The signing time as AWS spells it, `20150830T123600Z`. */
  readonly amzDate: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string | undefined
}

/**
 * The headers that sign one request with AWS Signature Version 4.
 *
 * Every header given is signed, with `host` and `x-amz-date` (and the
 * session token's header, when there is one) added. The query is not
 * signed: the one caller, GetSecretValue, sends none. `host` itself is
 * left out of the answer, since `fetch` sets it from the URL.
 */
export async function sigv4(request: SigV4Request): Promise<Record<string, string>> {
  const url = new URL(request.url)
  const day = request.amzDate.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value
  headers.host = url.host
  headers['x-amz-date'] = request.amzDate
  if (request.sessionToken !== undefined) headers['x-amz-security-token'] = request.sessionToken
  const names = Object.keys(headers).sort(compareCodePoints)
  const signed = names.join(';')
  const canonical = [
    request.method,
    url.pathname === '' ? '/' : url.pathname,
    '',
    names.map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join(''),
    signed,
    await sha256(request.body),
  ].join('\n')
  const scope = `${day}/${request.region}/${request.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', request.amzDate, scope, await sha256(canonical)].join('\n')
  let key = await hmac(`AWS4${request.secretAccessKey}`, day)
  for (const part of [request.region, request.service, 'aws4_request']) {
    key = await hmac(key, part)
  }
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host')),
    authorization:
      `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signed}, Signature=${hex(await hmac(key, toSign))}`,
  }
}

/**
 * Fetch one secret from AWS Secrets Manager with `fetch` alone.
 *
 * For a runtime the AWS SDK does not serve, a Worker's or a browser's:
 * one GetSecretValue POST signed with Signature Version 4 through Web
 * Crypto. There is no ambient credential chain there to fall back on,
 * so the config names its region and keys, and a profile, which only a
 * credentials file can resolve, is refused. The China regions answer
 * under their own partition's domain. A redirect is not followed, so
 * no answer can carry the signed request to another host. A binary
 * secret is refused: v1 reads `SecretString` only.
 */
export async function fetchAwsSmSigned(
  config: AWSSMConfig,
  ref: string,
  now: Date = new Date(),
): Promise<ResolvedSecret> {
  if (ref === '') {
    throw new SecretsError("the 'aws-sm' source needs a ref: the SecretId (name or ARN)")
  }
  if (config.awsProfile !== undefined) {
    throw new SecretsError(
      "the 'aws-sm' source can't read a profile here; give aws_access_key_id and aws_secret_access_key",
    )
  }
  const { region, awsAccessKeyId, awsSecretAccessKey, awsSessionToken } = config
  if (region === undefined || awsAccessKeyId === undefined || awsSecretAccessKey === undefined) {
    throw new SecretsError(
      "the 'aws-sm' source needs region, aws_access_key_id and aws_secret_access_key here",
    )
  }
  if (!REGION.test(region)) {
    throw new SecretsError(`the 'aws-sm' source's region is an AWS region, got '${region}'`)
  }
  const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'
  const url = `https://secretsmanager.${region}.${domain}/`
  const body = JSON.stringify({ SecretId: ref })
  const headers = await sigv4({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'secretsmanager.GetSecretValue',
    },
    body,
    region,
    service: 'secretsmanager',
    amzDate: now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, ''),
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
    sessionToken: awsSessionToken,
  })
  const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual' })
  const text = await response.text()
  let answer: Record<string, unknown> = {}
  try {
    answer = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not JSON: the status alone names the failure below.
  }
  if (!response.ok) {
    // `__type` is `com.amazonaws...#ResourceNotFoundException`; the
    // name after the `#` is what AWS's own SDKs raise.
    const type = typeof answer.__type === 'string' ? answer.__type : String(response.status)
    throw new SecretsError(`aws-sm answered ${type.split('#').at(-1) ?? type} for '${ref}'`)
  }
  const secret = answer.SecretString
  if (typeof secret !== 'string') {
    throw new SecretsError(`secret '${ref}' is binary (SecretBinary); v1 reads SecretString only`)
  }
  return { fields: fieldsFromSecretString(secret) }
}
