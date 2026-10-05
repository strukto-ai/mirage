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

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { mirageHome } from '@struktoai/mirage-server/paths'

const LOGIN_FILE = 'login.json'
export const LOGIN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const REFRESH_MARGIN_SECONDS = 60

/** The login cannot give a token: it is too old, or the issuer refused to refresh it. */
export class LoginError extends Error {
  override readonly name = 'LoginError'
}

/**
 * What `mirage login` keeps, for the one server it logged in to: the
 * server the token is for (it goes nowhere else), the bearer token, when
 * the user signed in (the login ends 30 days later, however often it was
 * refreshed), the refresh token (null for a pasted token), when the
 * access token ends if known, the OAuth client that signed in, and where
 * a refresh goes.
 */
export interface Login {
  url: string
  access_token: string
  logged_in_at: number
  refresh_token: string | null
  expires_at: number | null
  client_id: string | null
  token_endpoint: string | null
}

/** When the user has to log in again. */
export function renewBy(login: Login): number {
  const ends = login.logged_in_at + LOGIN_MAX_AGE_SECONDS
  if (login.refresh_token === null && login.expires_at !== null) {
    return Math.min(ends, login.expires_at)
  }
  return ends
}

export function loginPath(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), LOGIN_FILE)
}

/** The stored login, or null when there is none. */
export function readLogin(path: string = loginPath()): Login | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as Login
}

/** Store a login, readable by this user only. */
export function writeLogin(login: Login, path: string = loginPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const staged = join(dirname(path), `.${LOGIN_FILE}.${String(process.pid)}`)
  const fd = openSync(staged, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(login, null, 2))
  } finally {
    closeSync(fd)
  }
  renameSync(staged, path)
}

/** Forget the stored login; returns the login removed, or null when there was none. */
export function removeLogin(path: string = loginPath()): Login | null {
  const login = readLogin(path)
  rmSync(path, { force: true })
  return login
}

/** A JWT's claims, unchecked, to show and to time; empty when it is not a JWT. */
export function tokenClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8'))
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** An OAuth endpoint's JSON object, or empty when it sent none. */
export async function jsonBody(reply: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await reply.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** When a token endpoint's access token ends, or null when it gave no `expires_in`. */
export function endsAt(body: Record<string, unknown>, now: number): number | null {
  const expiresIn = body.expires_in
  return typeof expiresIn === 'number' && expiresIn > 0 ? now + expiresIn : null
}

/**
 * The login's access token, refreshed first when it is about to end;
 * `login` is updated in place and stored at `path` on a refresh. Throws
 * `LoginError` when the login is over 30 days old, its token ended with
 * nothing to refresh it, or the issuer refused the refresh.
 */
export async function freshToken(login: Login, path: string = loginPath()): Promise<string> {
  const now = Date.now() / 1000
  const again = `run \`mirage login\` to log in to ${login.url} again`
  if (now >= login.logged_in_at + LOGIN_MAX_AGE_SECONDS) {
    throw new LoginError(`the login is 30 days old; ${again}`)
  }
  if (login.expires_at === null || now < login.expires_at - REFRESH_MARGIN_SECONDS) {
    return login.access_token
  }
  if (login.refresh_token === null || login.token_endpoint === null || login.client_id === null) {
    throw new LoginError(`the token has expired; ${again}`)
  }
  let reply: Response
  try {
    reply = await fetch(login.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: login.refresh_token,
        client_id: login.client_id,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new LoginError(`could not reach the issuer: ${String(error)}`)
  }
  const body = await jsonBody(reply)
  if (reply.status !== 200 || typeof body.access_token !== 'string') {
    const reason = typeof body.error === 'string' ? body.error : String(reply.status)
    throw new LoginError(`the issuer refused to refresh the login (${reason}); ${again}`)
  }
  login.access_token = body.access_token
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {
    login.refresh_token = body.refresh_token
  }
  login.expires_at = endsAt(body, now)
  writeLogin(login, path)
  return login.access_token
}
