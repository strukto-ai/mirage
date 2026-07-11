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

import { readFileSync } from 'node:fs'

import { DEFAULT_TOKEN_FILE, readTokenFile } from './storage.ts'

export const ENV_AUTH_MODE = 'MIRAGE_AUTH_MODE'
export const ENV_AUTH_TOKEN = 'MIRAGE_AUTH_TOKEN'
export const ENV_JWT_PUBKEY = 'MIRAGE_JWT_PUBKEY'
export const ENV_JWT_PUBKEY_FILE = 'MIRAGE_JWT_PUBKEY_FILE'
export const ENV_JWT_ALG = 'MIRAGE_JWT_ALG'
export const ENV_JWT_ISSUER = 'MIRAGE_JWT_ISSUER'
export const ENV_JWT_AUDIENCE = 'MIRAGE_JWT_AUDIENCE'
export const ENV_JWT_AUTHORIZED_PARTIES = 'MIRAGE_JWT_AUTHORIZED_PARTIES'
export const ENV_JWT_CLOCK_SKEW = 'MIRAGE_JWT_CLOCK_SKEW_SECONDS'

export const AuthMode = {
  Local: 'local',
  Token: 'token',
  Jwt: 'jwt',
} as const
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

const VALID_MODES: readonly AuthMode[] = Object.values(AuthMode)
const DEFAULT_CLOCK_SKEW_SECONDS = 5

export interface JWTConfig {
  readonly key: string
  readonly algorithm: string
  readonly issuer?: string
  readonly audience?: string
  readonly authorizedParties: readonly string[]
  readonly clockSkewSeconds: number
}

export interface AuthConfig {
  readonly mode: AuthMode
  readonly localToken?: string
  readonly bearerToken?: string
  readonly jwt?: JWTConfig
}

export interface ResolveOptions {
  readonly env?: Record<string, string | undefined>
  readonly tokenFile?: string
}

function pickEnv(opts: ResolveOptions | undefined): Record<string, string | undefined> {
  if (opts?.env !== undefined) return opts.env
  return process.env
}

function pickTokenFile(opts: ResolveOptions | undefined): string {
  return opts?.tokenFile ?? DEFAULT_TOKEN_FILE
}

export function resolveLocalToken(opts?: ResolveOptions): string | undefined {
  const env = pickEnv(opts)
  const fromEnv = (env[ENV_AUTH_TOKEN] ?? '').trim()
  if (fromEnv.length > 0) return fromEnv
  return readTokenFile(pickTokenFile(opts))
}

function readJwtKey(env: Record<string, string | undefined>): string {
  const inline = (env[ENV_JWT_PUBKEY] ?? '').trim()
  if (inline.length > 0) return inline
  const path = (env[ENV_JWT_PUBKEY_FILE] ?? '').trim()
  if (path.length > 0) return readFileSync(path, 'utf-8')
  throw new Error(`mode=jwt requires ${ENV_JWT_PUBKEY} or ${ENV_JWT_PUBKEY_FILE}`)
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function isAuthMode(value: string): value is AuthMode {
  return (VALID_MODES as readonly string[]).includes(value)
}

export function resolveAuthConfig(opts?: ResolveOptions): AuthConfig {
  const env = pickEnv(opts)
  const raw = (env[ENV_AUTH_MODE] ?? AuthMode.Local).trim().toLowerCase() || AuthMode.Local
  if (!isAuthMode(raw)) {
    throw new Error(
      `${ENV_AUTH_MODE} must be one of ${VALID_MODES.join('|')}, got ${JSON.stringify(raw)}`,
    )
  }
  const mode: AuthMode = raw
  if (mode === AuthMode.Local) {
    const localToken = resolveLocalToken(opts)
    return localToken === undefined ? { mode } : { mode, localToken }
  }
  if (mode === AuthMode.Token) {
    const token = (env[ENV_AUTH_TOKEN] ?? '').trim()
    if (!token) {
      throw new Error(`mode=token requires ${ENV_AUTH_TOKEN} to be set`)
    }
    return { mode, bearerToken: token }
  }
  const key = readJwtKey(env)
  const alg = (env[ENV_JWT_ALG] ?? '').trim()
  if (!alg) {
    throw new Error(`mode=jwt requires ${ENV_JWT_ALG} (e.g. RS256)`)
  }
  const issuer = (env[ENV_JWT_ISSUER] ?? '').trim() || undefined
  const audience = (env[ENV_JWT_AUDIENCE] ?? '').trim() || undefined
  const azp = parseCsv(env[ENV_JWT_AUTHORIZED_PARTIES] ?? '')
  const skewRaw = (env[ENV_JWT_CLOCK_SKEW] ?? '').trim()
  const skew = skewRaw.length > 0 ? Number.parseInt(skewRaw, 10) : DEFAULT_CLOCK_SKEW_SECONDS
  const jwt: JWTConfig = {
    key,
    algorithm: alg,
    authorizedParties: azp,
    clockSkewSeconds: skew,
    ...(issuer !== undefined ? { issuer } : {}),
    ...(audience !== undefined ? { audience } : {}),
  }
  return { mode: AuthMode.Jwt, jwt }
}
