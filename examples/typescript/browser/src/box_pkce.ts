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
 * Minimal end-to-end PKCE smoke test for Box.
 *
 * Setup:
 *  1. Create a Box app at https://app.box.com/developers/console
 *     - Type: Custom App, Authentication: User Authentication (OAuth 2.0)
 *     - Configuration tab:
 *       * Redirect URIs: http://localhost:5173/box_pkce.html
 *       * CORS Domains: http://localhost:5173
 *       * Application Scopes: Read all files and folders stored in Box
 *     - Authorization tab: submit for review (if your enterprise requires it)
 *  2. Set BOX_CLIENT_ID in .env.development.
 *  3. pnpm dev → open http://localhost:5173/box_pkce.html.
 *
 * Note: Box rotates the refresh token on every refresh, so the version stored
 * in localStorage is updated by `onRefreshTokenRotated` after each TokenManager
 * refresh. If you wipe localStorage you'll need to reconnect.
 */
import { BoxVFS, MountMode, Workspace } from '@struktoai/mirage-browser'
import { escapeHtml } from './html.ts'

declare const __BOX_CLIENT_ID__: string

const AUTH_URL = 'https://account.box.com/api/oauth2/authorize'
const TOKEN_URL = 'https://api.box.com/oauth2/token'
const REDIRECT_URI = `${window.location.origin}/box_pkce.html`
const STORAGE_KEY = 'mirage-box-pkce-example'
const STATE_PREFIX = 'mirage-box-state:'

interface StoredTokens {
  refresh: string
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
  if (__BOX_CLIENT_ID__ === '') {
    throw new Error('BOX_CLIENT_ID is empty — set it in .env.development (repo root).')
  }
  return __BOX_CLIENT_ID__
}

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<StoredTokens>
    if (typeof parsed.refresh !== 'string') return null
    return { refresh: parsed.refresh }
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

async function beginAuth(): Promise<void> {
  const verifier = randomString(48)
  const code_challenge = await challenge(verifier)
  const state = randomString(18)
  sessionStorage.setItem(STATE_PREFIX + state, JSON.stringify({ verifier }))
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge,
    code_challenge_method: 'S256',
    state,
  })
  window.location.href = `${AUTH_URL}?${params.toString()}`
}

async function exchangeCode(code: string, state: string): Promise<StoredTokens> {
  const raw = sessionStorage.getItem(STATE_PREFIX + state)
  if (raw === null) throw new Error('OAuth state not found (possible CSRF or expired session).')
  sessionStorage.removeItem(STATE_PREFIX + state)
  const { verifier } = JSON.parse(raw) as { verifier: string }

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
  const data = (await r.json()) as { refresh_token?: string }
  if (data.refresh_token === undefined) {
    throw new Error('Box did not return a refresh token. Re-check the app authorization.')
  }
  return { refresh: data.refresh_token }
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
  const box = new BoxVFS({
    clientId: clientId(),
    refreshToken: tokens.refresh,
    onRefreshTokenRotated: (next: string): void => {
      writeTokens({ refresh: next })
    },
  })
  const ws = new Workspace({ '/box': box }, { mode: MountMode.READ })

  line('━━━ /box (PKCE refresh, no client_secret) ━━━', 'prompt')
  await run(ws, 'ls /box/')
  await run(ws, 'ls /box/ | head -n 20')
  line('', 'ok')
  line('PKCE end-to-end OK. Refresh tokens are rotated; check localStorage.', 'ok')
}

async function main(): Promise<void> {
  if (clientId() === '') {
    setStatus(
      'Set <code>BOX_CLIENT_ID</code> in <code>.env.development</code> at the repo root, then reload.',
    )
    return
  }

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errParam = url.searchParams.get('error')

  if (errParam !== null) {
    setStatus(`<span class="err">Box declined the consent: ${escapeHtml(errParam)}</span>`)
    return
  }

  if (code !== null && state !== null) {
    setStatus('Exchanging authorization code…')
    try {
      const tokens = await exchangeCode(code, state)
      writeTokens(tokens)
      window.history.replaceState({}, document.title, '/box_pkce.html')
    } catch (err) {
      setStatus(
        `<span class="err">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
      )
      return
    }
  }

  const stored = readTokens()
  if (stored === null) {
    setStatus(`Not connected. <button id="connect">Connect Box</button>`)
    document.getElementById('connect')?.addEventListener('click', () => {
      void beginAuth()
    })
    return
  }

  setStatus(`Connected. <button id="disconnect">Disconnect</button>`)
  document.getElementById('disconnect')?.addEventListener('click', () => {
    clearTokensStorage()
    window.location.reload()
  })

  try {
    await runDemo(stored)
  } catch (err) {
    line(err instanceof Error ? err.message : String(err), 'err')
  }
}

void main()
