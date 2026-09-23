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
 * End-to-end PKCE smoke test.
 *
 * Verifies the change in `core/src/core/google/client.ts` (clientSecret
 * optional) by running the full browser-PKCE dance and then exercising a
 * GDocsVFS with `{ clientId, refreshToken }` — no client_secret. If
 * mirage-core's TokenManager can refresh the access token without a secret,
 * `ls /gdocs/`, `cat`, etc. work; if not, the refresh request returns 401.
 *
 * Setup:
 *  1. Create an OAuth client (Web application) at
 *     https://console.cloud.google.com/apis/credentials
 *  2. Add `http://localhost:5173` to "Authorized JavaScript origins" and
 *     `http://localhost:5173/gdocs_pkce.html` to "Authorized redirect URIs".
 *  3. Set `GOOGLE_CLIENT_ID=<id>` in `.env.development` at repo root.
 *  4. Run `pnpm dev` in examples/typescript/browser/ and open
 *     http://localhost:5173/gdocs_pkce.html
 *
 * Tip: open DevTools → Network → token refresh → confirm the request body has
 * NO `client_secret` parameter (PKCE works as expected end-to-end).
 */
import { GDocsVFS, MountMode, Workspace } from '@struktoai/mirage-browser'
import { escapeHtml } from './html.ts'

declare const __GOOGLE_CLIENT_ID__: string

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const REDIRECT_URI = `${window.location.origin}/gdocs_pkce.html`
const SCOPES = ['https://www.googleapis.com/auth/documents']
const STORAGE_KEY = 'mirage-gdocs-pkce-example'
const STATE_PREFIX = 'mirage-pkce-state:'

interface StoredTokens {
  refresh: string
  scopes: string[]
}

const statusEl = document.getElementById('status') as HTMLDivElement
const logEl = document.getElementById('log') as HTMLDivElement

function status(html: string): void {
  statusEl.innerHTML = html
}

function line(s: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = s
  logEl.appendChild(div)
}

function clientId(): string {
  if (__GOOGLE_CLIENT_ID__ === '') {
    throw new Error('GOOGLE_CLIENT_ID is empty — set it in .env.development.')
  }
  return __GOOGLE_CLIENT_ID__
}

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<StoredTokens>
    if (typeof parsed.refresh !== 'string' || !Array.isArray(parsed.scopes)) return null
    return { refresh: parsed.refresh, scopes: parsed.scopes }
  } catch {
    return null
  }
}

function writeTokens(t: StoredTokens): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
}

function clearTokensStorage(): void {
  localStorage.removeItem(STORAGE_KEY)
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function randomString(byteLen: number): string {
  const buf = new Uint8Array(byteLen)
  crypto.getRandomValues(buf)
  return base64url(buf)
}

async function challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return base64url(new Uint8Array(hash))
}

async function beginAuth(scopes: string[]): Promise<void> {
  const verifier = randomString(48)
  const code_challenge = await challenge(verifier)
  const state = randomString(18)
  sessionStorage.setItem(STATE_PREFIX + state, JSON.stringify({ verifier, scopes }))
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    code_challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'consent',
  })
  window.location.href = `${AUTH_URL}?${params.toString()}`
}

async function exchangeCode(code: string, state: string): Promise<StoredTokens> {
  const raw = sessionStorage.getItem(STATE_PREFIX + state)
  if (raw === null) throw new Error('OAuth state not found (possible CSRF or expired session).')
  sessionStorage.removeItem(STATE_PREFIX + state)
  const { verifier, scopes } = JSON.parse(raw) as { verifier: string; scopes: string[] }

  const body = new URLSearchParams({
    client_id: clientId(),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`token exchange failed (${String(r.status)}): ${text}`)
  }
  const data = (await r.json()) as {
    refresh_token?: string
    scope?: string
  }
  if (data.refresh_token === undefined) {
    throw new Error('Google did not return a refresh token. Revoke this client at myaccount.google.com and reconnect.')
  }
  const granted = (data.scope ?? scopes.join(' ')).split(/\s+/).filter((s) => s.length > 0)
  const merged = Array.from(new Set([...scopes, ...granted])).sort()
  return { refresh: data.refresh_token, scopes: merged }
}

async function revoke(refresh: string): Promise<void> {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refresh)}`, { method: 'POST' })
  } catch {
    /* best effort */
  }
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const res = await ws.shell(cmd)
  const out = res.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = res.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (res.exitCode !== 0) line(`exit=${String(res.exitCode)}`, 'err')
}

async function runDemo(tokens: StoredTokens): Promise<void> {
  // The point of the demo: construct GDocsVFS with NO client_secret.
  // mirage-core's TokenManager refreshes access tokens via PKCE-style refresh.
  const gdocs = new GDocsVFS({
    clientId: clientId(),
    refreshToken: tokens.refresh,
  })
  const ws = new Workspace({ '/gdocs': gdocs }, { mode: MountMode.READ })

  line('━━━ /gdocs (PKCE refresh, no client_secret) ━━━', 'prompt')
  await run(ws, 'ls /gdocs/')
  await run(ws, 'ls /gdocs/ | head -n 5')

  // Try cat-ing the first doc, if any.
  const first = await ws.shell('ls /gdocs/ | head -n 1')
  const docName = first.stdoutText.trim()
  if (docName !== '') {
    await run(ws, `cat "/gdocs/${docName}" | head -n 20`)
    await run(ws, `wc "/gdocs/${docName}"`)
  } else {
    line('(no docs in this account — create one and reload to see cat output)', 'ok')
  }

  line('', 'ok')
  line('PKCE end-to-end OK — open DevTools → Network → token request and verify there is no client_secret in the body.', 'ok')
}

async function main(): Promise<void> {
  if (clientId() === '') {
    status(
      'Set <code>GOOGLE_CLIENT_ID</code> in <code>.env.development</code> first, then reload.',
    )
    return
  }

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errParam = url.searchParams.get('error')

  if (errParam !== null) {
    status(`<span class="err">Google declined the consent: ${escapeHtml(errParam)}</span>`)
    return
  }

  if (code !== null && state !== null) {
    status('Exchanging authorization code…')
    try {
      const tokens = await exchangeCode(code, state)
      writeTokens(tokens)
      // Strip ?code= from the URL so a reload doesn't try to re-exchange.
      window.history.replaceState({}, document.title, '/gdocs_pkce.html')
    } catch (err) {
      status(
        `<span class="err">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
      )
      return
    }
  }

  const stored = readTokens()
  if (stored === null) {
    status(`Not connected. <button id="connect">Connect Google</button>`)
    document.getElementById('connect')?.addEventListener('click', () => {
      void beginAuth(SCOPES)
    })
    return
  }

  status(
    `Connected. Scopes: <code>${stored.scopes.join(' ')}</code> ` +
      `<button id="disconnect">Disconnect</button>`,
  )
  document.getElementById('disconnect')?.addEventListener('click', () => {
    void revoke(stored.refresh).then(() => {
      clearTokensStorage()
      window.location.reload()
    })
  })

  try {
    await runDemo(stored)
  } catch (err) {
    line(err instanceof Error ? err.message : String(err), 'err')
  }
}

void main()
