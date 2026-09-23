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
 * Minimal end-to-end PKCE smoke test for Google Drive.
 *
 * 1. Click "Connect Google" — does the PKCE redirect dance.
 * 2. Comes back with a refresh token, persists it in localStorage.
 * 3. Mounts GDriveVFS with `{ clientId, refreshToken }` — no client_secret.
 * 4. Runs `ls /gdrive/` — exercises mirage-core's TokenManager refresh path
 *    (which now omits `client_secret` when absent, per the v0 fix).
 *
 * Setup:
 *  1. In Google Cloud Console → APIs & Services → Credentials, create an
 *     OAuth client of type "Web application". Add:
 *       Authorized JavaScript origins:   http://localhost:5173
 *       Authorized redirect URIs:        http://localhost:5173/gdrive_pkce.html
 *  2. Set `GOOGLE_CLIENT_ID=<your-id>` in `.env.development` (repo root).
 *  3. `pnpm dev` from `examples/typescript/browser/`.
 *  4. Open http://localhost:5173/gdrive_pkce.html
 */
import { GDriveVFS, MountMode, Workspace } from '@struktoai/mirage-browser'
import { escapeHtml } from './html.ts'

declare const __GOOGLE_CLIENT_ID__: string
declare const __GOOGLE_CLIENT_SECRET__: string

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const REDIRECT_URI = `${window.location.origin}/gdrive_pkce.html`
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
const STORAGE_KEY = 'mirage-gdrive-pkce-example'
const STATE_PREFIX = 'mirage-gdrive-state:'

interface StoredTokens {
  refresh: string
  scopes: string[]
}

const statusEl = document.getElementById('status') as HTMLDivElement
const logEl = document.getElementById('log') as HTMLDivElement

function setStatus(html: string): void {
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
    throw new Error(
      'GOOGLE_CLIENT_ID is empty — set it in .env.development (repo root).',
    )
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
  if (__GOOGLE_CLIENT_SECRET__ !== '') body.set('client_secret', __GOOGLE_CLIENT_SECRET__)
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`token exchange failed (${String(r.status)}): ${text}`)
  }
  const data = (await r.json()) as { refresh_token?: string; scope?: string }
  if (data.refresh_token === undefined) {
    throw new Error(
      'Google did not return a refresh token. Revoke this client at myaccount.google.com/permissions and reconnect.',
    )
  }
  const granted = (data.scope ?? scopes.join(' '))
    .split(/\s+/)
    .filter((s) => s.length > 0)
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
  // The point: GDriveVFS constructed with NO client_secret. mirage-core's
  // TokenManager will refresh access tokens via the PKCE-style refresh path.
  const gdrive = new GDriveVFS({
    clientId: clientId(),
    // Google's Web client refuses refresh without the secret. The verifier
    // already authenticated us at code-exchange time; the secret here is
    // just a registration identifier on the refresh path.
    ...(__GOOGLE_CLIENT_SECRET__ !== '' ? { clientSecret: __GOOGLE_CLIENT_SECRET__ } : {}),
    refreshToken: tokens.refresh,
  })
  const ws = new Workspace({ '/gdrive': gdrive }, { mode: MountMode.READ })

  line('━━━ /gdrive (PKCE refresh, no client_secret) ━━━', 'prompt')
  await run(ws, 'ls /gdrive/')
  await run(ws, 'ls /gdrive/ | head -n 20')
  await run(ws, 'ls /gdrive/ | wc -l')

  line('', 'ok')
  line(
    'PKCE end-to-end OK. Open DevTools → Network → filter "token" → confirm the refresh request body has NO client_secret field.',
    'ok',
  )
}

async function main(): Promise<void> {
  if (clientId() === '') {
    setStatus(
      'Set <code>GOOGLE_CLIENT_ID</code> in <code>.env.development</code> at the repo root, then reload.',
    )
    return
  }

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errParam = url.searchParams.get('error')

  if (errParam !== null) {
    setStatus(`<span class="err">Google declined the consent: ${escapeHtml(errParam)}</span>`)
    return
  }

  if (code !== null && state !== null) {
    setStatus('Exchanging authorization code…')
    try {
      const tokens = await exchangeCode(code, state)
      writeTokens(tokens)
      // Strip ?code= so a reload doesn't try to re-exchange a one-time code.
      window.history.replaceState({}, document.title, '/gdrive_pkce.html')
    } catch (err) {
      setStatus(
        `<span class="err">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
      )
      return
    }
  }

  const stored = readTokens()
  if (stored === null) {
    setStatus(`Not connected. <button id="connect">Connect Google</button>`)
    document.getElementById('connect')?.addEventListener('click', () => {
      void beginAuth(SCOPES)
    })
    return
  }

  setStatus(
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
