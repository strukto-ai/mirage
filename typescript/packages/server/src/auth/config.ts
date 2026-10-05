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

import { readDaemonTable } from '../daemon_config.ts'
import { mirageHome } from '../paths.ts'
import { defaultTokenFile, readTokenFile } from './storage.ts'

export const ENV_AUTH_MODE = 'MIRAGE_AUTH_MODE'
export const ENV_AUTH_TOKEN = 'MIRAGE_AUTH_TOKEN'
export const ENV_JWT_PUBKEY = 'MIRAGE_JWT_PUBKEY'
export const ENV_JWT_PUBKEY_FILE = 'MIRAGE_JWT_PUBKEY_FILE'
export const ENV_JWT_JWKS_URL = 'MIRAGE_JWT_JWKS_URL'
export const ENV_JWT_ALG = 'MIRAGE_JWT_ALG'
export const ENV_JWT_ISSUER = 'MIRAGE_JWT_ISSUER'
export const ENV_JWT_AUDIENCE = 'MIRAGE_JWT_AUDIENCE'
export const ENV_JWT_AUTHORIZED_PARTIES = 'MIRAGE_JWT_AUTHORIZED_PARTIES'
export const ENV_JWT_CLOCK_SKEW = 'MIRAGE_JWT_CLOCK_SKEW_SECONDS'
export const ENV_LOGIN_CLIENT_ID = 'MIRAGE_LOGIN_CLIENT_ID'

export const AuthMode = {
  Local: 'local',
  Token: 'token',
  Jwt: 'jwt',
} as const
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

const VALID_MODES: readonly AuthMode[] = Object.values(AuthMode)
const DEFAULT_CLOCK_SKEW_SECONDS = 5
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

/**
 * How the server checks a JWT: the one accepted algorithm; the issuer's
 * public key (PEM), or the URL where it publishes its keys; the required
 * `iss`; the audiences a token with `aud` must name one of; the parties a
 * token without `aud` must carry as its `azp`; the leeway on `exp`; and
 * the issuer's OAuth client that `mirage login` signs in through,
 * published at `/.well-known/oauth-protected-resource` (absent publishes
 * no login).
 */
export interface JWTConfig {
  readonly algorithm: string
  readonly key?: string
  readonly jwksUrl?: string
  readonly issuer?: string
  readonly audiences: readonly string[]
  readonly authorizedParties: readonly string[]
  readonly clockSkewSeconds: number
  readonly loginClientId?: string
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
  readonly table?: Record<string, string>
}

const CONFIG_ENV_KEYS: Record<string, string> = {
  auth_mode: ENV_AUTH_MODE,
  jwt_alg: ENV_JWT_ALG,
  jwt_issuer: ENV_JWT_ISSUER,
  jwt_audience: ENV_JWT_AUDIENCE,
  jwt_pubkey_file: ENV_JWT_PUBKEY_FILE,
  jwt_jwks_url: ENV_JWT_JWKS_URL,
  jwt_clock_skew: ENV_JWT_CLOCK_SKEW,
  jwt_authorized_parties: ENV_JWT_AUTHORIZED_PARTIES,
  login_client_id: ENV_LOGIN_CLIENT_ID,
}

function mergeConfigTable(
  env: Record<string, string | undefined>,
  table: Record<string, string>,
): Record<string, string | undefined> {
  const merged = { ...env }
  for (const [cfgKey, envName] of Object.entries(CONFIG_ENV_KEYS)) {
    if ((merged[envName] ?? '').trim() !== '') continue
    const value = table[cfgKey]
    if (value !== undefined && value.trim() !== '') merged[envName] = value
  }
  return merged
}

function pickEnv(opts: ResolveOptions | undefined): Record<string, string | undefined> {
  if (opts?.env !== undefined) return opts.env
  return process.env
}

function pickTable(opts: ResolveOptions | undefined): Record<string, string> {
  if (opts?.table !== undefined) return opts.table
  if (opts?.env !== undefined) return {}
  return readDaemonTable(mirageHome())
}

function pickTokenFile(opts: ResolveOptions | undefined): string {
  return opts?.tokenFile ?? defaultTokenFile()
}

export function resolveLocalToken(opts?: ResolveOptions): string | undefined {
  const env = pickEnv(opts)
  const fromEnv = (env[ENV_AUTH_TOKEN] ?? '').trim()
  if (fromEnv.length > 0) return fromEnv
  return readTokenFile(pickTokenFile(opts))
}

function readJwtKey(env: Record<string, string | undefined>): string | undefined {
  const inline = (env[ENV_JWT_PUBKEY] ?? '').trim()
  if (inline.length > 0) return inline
  const path = (env[ENV_JWT_PUBKEY_FILE] ?? '').trim()
  if (path.length > 0) return readFileSync(path, 'utf-8')
  return undefined
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
  const env = mergeConfigTable(pickEnv(opts), pickTable(opts))
  const raw = (env[ENV_AUTH_MODE] ?? AuthMode.Local).trim().toLowerCase() || AuthMode.Local
  if (!isAuthMode(raw)) {
    throw new Error(
      `${ENV_AUTH_MODE} must be one of ${VALID_MODES.join('|')}, got ${JSON.stringify(raw)}`,
    )
  }
  const mode: AuthMode = raw
  const loginClientId = (env[ENV_LOGIN_CLIENT_ID] ?? '').trim() || undefined
  if (loginClientId !== undefined && mode !== AuthMode.Jwt) {
    throw new Error(`${ENV_LOGIN_CLIENT_ID} requires mode=jwt`)
  }
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
  const jwksUrl = (env[ENV_JWT_JWKS_URL] ?? '').trim() || undefined
  if ((key === undefined) === (jwksUrl === undefined)) {
    throw new Error(
      `mode=jwt requires one of ${ENV_JWT_PUBKEY}, ${ENV_JWT_PUBKEY_FILE} or ${ENV_JWT_JWKS_URL}`,
    )
  }
  const alg = (env[ENV_JWT_ALG] ?? '').trim()
  if (!alg) {
    throw new Error(`mode=jwt requires ${ENV_JWT_ALG} (e.g. RS256)`)
  }
  const issuer = (env[ENV_JWT_ISSUER] ?? '').trim() || undefined
  const audiences = parseCsv(env[ENV_JWT_AUDIENCE] ?? '')
  const azp = parseCsv(env[ENV_JWT_AUTHORIZED_PARTIES] ?? '')
  const skewRaw = (env[ENV_JWT_CLOCK_SKEW] ?? '').trim()
  const skew = skewRaw.length > 0 ? Number.parseInt(skewRaw, 10) : DEFAULT_CLOCK_SKEW_SECONDS
  if (loginClientId !== undefined && (issuer === undefined || !audiences.includes(loginClientId))) {
    throw new Error(
      `${ENV_LOGIN_CLIENT_ID} requires ${ENV_JWT_ISSUER}, and ${ENV_JWT_AUDIENCE} must list it`,
    )
  }
  const jwt: JWTConfig = {
    algorithm: alg,
    audiences,
    authorizedParties: azp,
    clockSkewSeconds: skew,
    ...(key !== undefined ? { key } : {}),
    ...(jwksUrl !== undefined ? { jwksUrl } : {}),
    ...(issuer !== undefined ? { issuer } : {}),
    ...(loginClientId !== undefined ? { loginClientId } : {}),
  }
  return { mode: AuthMode.Jwt, jwt }
}
