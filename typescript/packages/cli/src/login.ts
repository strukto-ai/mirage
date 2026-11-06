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

import { readDaemonTable } from '@struktoai/mirage-server/daemon_config'
import { mirageHome } from '@struktoai/mirage-server/paths'
import { HOSTED, HOSTED_URL, LOCAL } from './constants.ts'
import {
  ContextError,
  LoginError,
  checkName,
  contextNames,
  currentName,
  emptyContext,
  endsAt,
  jsonBody,
  loginPath,
  readContext,
  readCurrent,
  readLogin,
  removeContext,
  removeLogin,
  renewBy,
  tokenClaims,
  writeContext,
  writeCurrent,
  writeLogin,
  type Login,
} from './credentials.ts'
import { emit, fail, formatTable } from './output.ts'
import { currentWorkspace, header, isLocalUrl, loadDaemonSettings, localUrl } from './settings.ts'

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
  if (!reply.ok) throw new LoginError(`${url} answered ${String(reply.status)}`)
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

/** The context a login makes when given no `--name`: `strukto` for the hosted console, `local` for this machine, else the server's host. */
function contextName(url: string): string {
  if (url === HOSTED_URL) return HOSTED
  if (isLocalUrl(url)) return LOCAL
  return new URL(url).hostname.toLowerCase()
}

/** The team a login acts for, as the server's `/v1/me` names it, or null when it names none. */
async function teamOf(url: string, token: string): Promise<string | null> {
  let reply: Response
  try {
    reply = await fetch(`${url}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    console.debug(`${url}/v1/me is out of reach: ${String(err)}`)
    return null
  }
  const team = reply.ok ? (await jsonBody(reply)).team_id : undefined
  return typeof team === 'string' && team !== '' ? team : null
}

/**
 * Keep a context for `url` and make it current. It keeps its workspace
 * while it points at the same server; `local` keeps no URL when `url` is
 * the one it follows anyway.
 */
async function saveContext(name: string, url: string, login: Login | null): Promise<void> {
  const team = login !== null ? await teamOf(url, login.access_token) : null
  const table = readDaemonTable(mirageHome(process.env))
  const kept = readContext(name)
  let stored = url
  if (name === LOCAL) {
    writeContext(LOCAL, emptyContext())
    if (url === localUrl(table)) stored = ''
  }
  writeContext(name, {
    url: stored,
    team,
    workspace: kept?.url === stored ? kept.workspace : null,
  })
  writeCurrent(name)
}

export function registerLoginCommands(program: Command): void {
  program
    .command('login')
    .description('Log in to a server and make it the current context.')
    .argument('[url]', 'The server; the hosted console when left out')
    .option(
      '--name <name>',
      "Name the context; by default strukto for the hosted console, local for this machine, else the server's host",
    )
    .option(
      '--token <token>',
      'Keep this token instead of using the browser; - reads it from stdin',
    )
    .action(async (given: string | undefined, opts: { name?: string; token?: string }) => {
      let token = opts.token
      if (token === '-') {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
        token = Buffer.concat(chunks).toString('utf-8').trim()
        if (token === '') fail('no token on stdin')
      }
      const url = rstripSlash(given ?? HOSTED_URL)
      const name = checkName(opts.name ?? contextName(url))
      const login =
        token !== undefined && token !== '' ? await tokenLogin(url, token) : await browserLogin(url)
      await saveContext(name, url, login)
      if (login === null) {
        process.stdout.write(noLogin(url) + '\n')
        return
      }
      writeLogin(login, loginPath(name))
      header('logged in', name)
      const account = tokenClaims(login.access_token).sub
      const who = typeof account === 'string' ? ` as ${account}.` : '.'
      process.stdout.write(`Logged in to ${url}${who}\n`)
    })
  program
    .command('logout')
    .description('Sign out of the current context; the context stays.')
    .action(() => {
      const login = removeLogin()
      process.stdout.write(login !== null ? `Logged out of ${login.url}.\n` : 'Not logged in.\n')
    })
  program
    .command('whoami')
    .description(
      'Print the current context: its server, team, user and workspace, and when to log in again.',
    )
    .action(() => {
      const url = rstripSlash(loadDaemonSettings().url)
      const name = currentName()
      const stored = readLogin(loginPath(name))
      const login = stored?.url === url ? stored : null
      const account = login !== null ? tokenClaims(login.access_token).sub : undefined
      emit(
        {
          context: name,
          url,
          team: readContext(name)?.team ?? null,
          user: typeof account === 'string' ? account : null,
          workspace: currentWorkspace(),
          renew_by:
            login !== null ? new Date(renewBy(login) * 1000).toISOString().slice(0, 10) : null,
        },
        (row) =>
          Object.entries(row)
            .map(([k, v]) => `${k}: ${v ?? '-'}`)
            .join('\n'),
      )
    })
}

interface ContextRow {
  name: string
  url: string
  team: string | null
  workspace: string | null
  current: boolean
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description('The servers the CLI talks to: list, switch, forget.')

  context
    .command('list')
    .description('List the contexts; the current one is marked.')
    .action(() => {
      const current = currentName()
      const table = readDaemonTable(mirageHome(process.env))
      const rows: ContextRow[] = contextNames().map((name) => {
        const entry = readContext(name) ?? emptyContext()
        return {
          name,
          url: entry.url !== '' ? entry.url : localUrl(table),
          team: entry.team,
          workspace: entry.workspace,
          current: name === current,
        }
      })
      emit(rows, (items) =>
        formatTable(
          ['', 'NAME', 'URL', 'TEAM', 'WORKSPACE'],
          items.map((r) => [r.current ? '*' : '', r.name, r.url, r.team ?? '', r.workspace ?? '']),
        ),
      )
    })

  context
    .command('use')
    .argument('<name>', 'Context name')
    .description('Make a context the current one.')
    .action((name: string) => {
      if (readContext(name) === null) {
        throw new ContextError(`no context '${name}'; run \`mirage context list\``)
      }
      writeCurrent(name)
      header('now current', name)
      emit({ current: name }, () => `Using context ${name}.`)
    })

  context
    .command('delete')
    .argument('<name>', 'Context name')
    .description('Forget a context and its login; `local` stays.')
    .action((name: string) => {
      if (name === LOCAL) throw new ContextError('the local context cannot be deleted')
      if (readContext(name) === null) {
        throw new ContextError(`no context '${name}'; run \`mirage context list\``)
      }
      if (readCurrent() === name) writeCurrent(LOCAL)
      removeContext(name)
      emit({ deleted: name }, () => `Deleted context ${name}.`)
    })
}
