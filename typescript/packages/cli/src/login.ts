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

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Command } from 'commander'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import {
  AUTHORIZATION_SERVER_PATH,
  PROTECTED_RESOURCE_PATH,
} from '@struktoai/mirage-server/auth/config'

import {
  LoginError,
  endsAt,
  jsonBody,
  readLogin,
  removeLogin,
  renewBy,
  tokenClaims,
  writeLogin,
  type Login,
} from './credentials.ts'
import { emit, fail } from './output.ts'
import { isLocalUrl, loadDaemonSettings } from './settings.ts'

const CALLBACK_PATH = '/callback'
const CALLBACK_TIMEOUT_SECONDS = 300
const SCOPE = 'profile email offline_access'

function noLogin(url: string): string {
  return (
    `${url} publishes no login: a local daemon needs none, and a server ` +
    'with a shared token takes `mirage login --token`'
  )
}

/** Where an issuer publishes its endpoints (RFC 8414). */
export function metadataUrl(issuer: string): string {
  const parts = new URL(issuer)
  return `${parts.protocol}//${parts.host}${AUTHORIZATION_SERVER_PATH}${rstripSlash(parts.pathname)}`
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let reply: Response
  try {
    reply = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new LoginError(`could not reach ${url}: ${String(error)}`)
  }
  if (reply.status !== 200) throw new LoginError(`${url} answered ${String(reply.status)}`)
  return jsonBody(reply)
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Open a URL in the browser: `$BROWSER` when set, else the system's
 * opener. The printed URL is the way in when none opens.
 */
function openBrowser(url: string): void {
  const custom = process.env.BROWSER ?? ''
  const [command, args]: [string, string[]] =
    custom !== ''
      ? [custom, [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', (error) => {
    console.error(`could not open the browser: ${error.message}`)
  })
  child.unref()
}

interface Callback {
  redirect: string
  answer: Promise<Record<string, string>>
  close: () => void
}

/** A one-time listener on 127.0.0.1 that the browser comes back to. */
async function listen(state: string): Promise<Callback> {
  let settle: (query: Record<string, string>) => void = () => undefined
  const answer = new Promise<Record<string, string>>((resolve) => {
    settle = resolve
  })
  const server = createServer((req, res) => {
    const parts = new URL(req.url ?? '/', 'http://127.0.0.1')
    const query = Object.fromEntries(parts.searchParams)
    if (parts.pathname !== CALLBACK_PATH || query.state !== state) {
      res.writeHead(404).end()
      return
    }
    const text =
      query.code !== undefined
        ? 'Logged in to Mirage. You can close this tab.'
        : `Login failed: ${query.error ?? 'no code'}.`
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><p>${escaped}</p>`)
    settle(query)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    redirect: `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`,
    answer,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/**
 * Log in through the server's issuer in the browser. The server names its
 * issuer and OAuth client; the browser signs in there (or is already
 * signed in) and comes back to a one-time listener on 127.0.0.1 with a
 * code, which is swapped for the tokens with PKCE, so no secret is kept
 * on this machine. Null when the server publishes no login.
 */
export async function browserLogin(url: string): Promise<Login | null> {
  let found: Response
  try {
    found = await fetch(url + PROTECTED_RESOURCE_PATH, { signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    if (isLocalUrl(url)) return null
    throw new LoginError(`could not reach ${url}: ${String(error)}`)
  }
  if (found.status === 404) return null
  const resource = await jsonBody(found)
  const servers = resource.authorization_servers
  const clientId = resource.client_id
  if (!Array.isArray(servers) || servers.length === 0 || typeof clientId !== 'string') {
    throw new LoginError(`${url} published no issuer to log in through`)
  }
  const issuer = String(servers[0])
  const meta = await getJson(metadataUrl(issuer))
  if (meta.issuer !== issuer) {
    throw new LoginError(`${issuer} published another issuer's endpoints`)
  }
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  const callback = await listen(state)
  let answer: Record<string, string>
  try {
    const authorize = new URL(String(meta.authorization_endpoint))
    const params = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: callback.redirect,
      scope: SCOPE,
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
    }
    for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value)
    process.stderr.write(
      `Log in to ${url} in your browser. If it does not open, go to:\n\n  ${authorize.href}\n\n`,
    )
    openBrowser(authorize.href)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new LoginError('the browser did not come back in time'))
      }, CALLBACK_TIMEOUT_SECONDS * 1000)
    })
    try {
      answer = await Promise.race([callback.answer, late])
    } finally {
      clearTimeout(timer)
    }
  } finally {
    callback.close()
  }
  const code = answer.code
  if (code === undefined) {
    throw new LoginError(`the issuer refused the login: ${answer.error ?? 'no code'}`)
  }
  const tokenEndpoint = String(meta.token_endpoint)
  const signedIn = Date.now() / 1000
  let reply: Response
  try {
    reply = await fetch(tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback.redirect,
        client_id: clientId,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new LoginError(`could not reach the issuer: ${String(error)}`)
  }
  const body = await jsonBody(reply)
  if (reply.status !== 200 || typeof body.access_token !== 'string') {
    const reason = typeof body.error === 'string' ? body.error : String(reply.status)
    throw new LoginError(`the issuer refused the code: ${reason}`)
  }
  const refresh = body.refresh_token
  return {
    url,
    access_token: body.access_token,
    logged_in_at: signedIn,
    refresh_token: typeof refresh === 'string' && refresh !== '' ? refresh : null,
    expires_at: endsAt(body, signedIn),
    client_id: clientId,
    token_endpoint: tokenEndpoint,
  }
}

/** Keep a pasted token, once the server takes it. */
export async function tokenLogin(url: string, token: string): Promise<Login> {
  let reply: Response
  try {
    reply = await fetch(`${url}/v1/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new LoginError(`could not reach ${url}: ${String(error)}`)
  }
  if (reply.status === 401) throw new LoginError(`${url} refused the token`)
  const exp = tokenClaims(token).exp
  return {
    url,
    access_token: token,
    logged_in_at: Date.now() / 1000,
    refresh_token: null,
    expires_at: typeof exp === 'number' ? exp : null,
    client_id: null,
    token_endpoint: null,
  }
}

export function registerLoginCommands(program: Command): void {
  program
    .command('login')
    .description('Log in to the server the CLI points at.')
    .option('--token <token>', 'Keep this token instead of using the browser')
    .action(async (opts: { token?: string }) => {
      const url = rstripSlash(loadDaemonSettings().url)
      const login =
        opts.token !== undefined && opts.token !== ''
          ? await tokenLogin(url, opts.token)
          : await browserLogin(url)
      if (login === null) {
        process.stdout.write(noLogin(url) + '\n')
        return
      }
      writeLogin(login)
      const account = tokenClaims(login.access_token).sub
      const who = typeof account === 'string' ? ` as ${account}.` : '.'
      process.stdout.write(`Logged in to ${url}${who}\n`)
    })
  program
    .command('logout')
    .description('Forget the stored login.')
    .action(() => {
      const login = removeLogin()
      process.stdout.write(login !== null ? `Logged out of ${login.url}.\n` : 'Not logged in.\n')
    })
  program
    .command('whoami')
    .description('Print who the login is for, and when to log in again.')
    .action(() => {
      const url = rstripSlash(loadDaemonSettings().url)
      const login = readLogin()
      if (login?.url !== url) fail(`not logged in to ${url}`)
      const account = tokenClaims(login.access_token).sub
      emit(
        {
          account: typeof account === 'string' ? account : null,
          url,
          renew_by: new Date(renewBy(login) * 1000).toISOString().slice(0, 10),
        },
        (row) =>
          Object.entries(row)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('\n'),
      )
    })
}
