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

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginError, readLogin, writeLogin } from './credentials.ts'
import { browserLogin, metadataUrl, registerLoginCommands, tokenLogin } from './login.ts'

const CLIENT_ID = 'client_cli'

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}

/**
 * A Mirage server's login metadata and a Clerk-shaped issuer, on one
 * port: the authorize step acts as an already signed-in user.
 */
class FakeClerk {
  url = ''
  readonly codes = new Map<string, Record<string, string>>()
  private server: Server | undefined

  constructor(readonly opts: { publishes?: boolean; deny?: boolean; issuer?: string } = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      const parts = new URL(req.url ?? '/', this.url)
      const query = Object.fromEntries(parts.searchParams)
      if (req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
        req.on('end', () => {
          const form = Object.fromEntries(new URLSearchParams(raw))
          const asked = this.codes.get(form.code ?? '')
          this.codes.delete(form.code ?? '')
          const proof = createHash('sha256')
            .update(form.code_verifier ?? '')
            .digest('base64url')
          if (
            asked === undefined ||
            form.grant_type !== 'authorization_code' ||
            form.client_id !== asked.client_id ||
            form.redirect_uri !== asked.redirect_uri ||
            asked.code_challenge_method !== 'S256' ||
            proof !== asked.code_challenge
          ) {
            reply(400, { error: 'invalid_grant' })
            return
          }
          reply(200, {
            access_token: jwt({ sub: 'user_alice' }),
            refresh_token: 'r1',
            expires_in: 86400,
            token_type: 'Bearer',
          })
        })
        return
      }
      if (parts.pathname === '/.well-known/oauth-protected-resource') {
        if (this.opts.publishes === false) {
          reply(404, { detail: 'no login' })
          return
        }
        reply(200, { resource: this.url, authorization_servers: [this.url], client_id: CLIENT_ID })
      } else if (parts.pathname === '/.well-known/oauth-authorization-server') {
        reply(200, {
          issuer: this.opts.issuer ?? this.url,
          authorization_endpoint: `${this.url}/oauth/authorize`,
          token_endpoint: `${this.url}/oauth/token`,
        })
      } else if (parts.pathname === '/oauth/authorize') {
        const answer = new URLSearchParams({ state: query.state ?? '' })
        if (this.opts.deny === true) {
          answer.set('error', 'access_denied')
        } else {
          const code = `code${String(this.codes.size)}`
          this.codes.set(code, query)
          answer.set('code', code)
        }
        reply(302, {}, { Location: `${query.redirect_uri ?? ''}?${answer.toString()}` })
      } else if (parts.pathname === '/v1/workspaces') {
        const status: Record<string, number> = { 'Bearer good': 200, 'Bearer boom': 500 }
        reply(status[req.headers.authorization ?? ''] ?? 401, [])
      } else {
        reply(404, {})
      }
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
    return this
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise((resolve) => this.server?.close(resolve))
  }
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk)
    return true
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error('__exit__')
  }) as never)
  const program = new Command()
  program.exitOverride()
  registerLoginCommands(program)
  try {
    await program.parseAsync(['node', 'mirage', ...args])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__exit__') throw e
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { stdout, stderr, exitCode }
}

describe('mirage login', () => {
  let dir: string
  let clerk: FakeClerk

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-login-'))
    const browser = join(dir, 'browser')
    // A browser where the user is already signed in: it follows the
    // issuer's redirect back to the CLI, and notes what it opened.
    writeFileSync(
      browser,
      `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'opened'))}, process.argv[2] + '\\n')\n` +
        'fetch(process.argv[2]).then((r) => process.exit(r.ok ? 0 : 1))\n',
    )
    chmodSync(browser, 0o755)
    vi.stubEnv('BROWSER', browser)
    vi.stubEnv('MIRAGE_HOME', dir)
    vi.stubEnv('MIRAGE_TOKEN', undefined)
    clerk = await new FakeClerk().start()
    vi.stubEnv('MIRAGE_DAEMON_URL', clerk.url)
  })

  afterEach(async () => {
    await clerk.stop()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function opened(): string[] {
    try {
      return readFileSync(join(dir, 'opened'), 'utf-8').trim().split('\n')
    } catch {
      return []
    }
  }

  it('signs in with PKCE and keeps the tokens', async () => {
    const login = await browserLogin(clerk.url)
    expect(login?.url).toBe(clerk.url)
    expect(login?.refresh_token).toBe('r1')
    expect(login?.client_id).toBe(CLIENT_ID)
    expect(login?.token_endpoint).toBe(`${clerk.url}/oauth/token`)
    expect((login?.expires_at ?? 0) - (login?.logged_in_at ?? 0)).toBeCloseTo(86400)
    const sent = new URL(opened()[0] ?? '').searchParams
    expect(sent.get('scope')).toBe('profile email offline_access')
    expect(sent.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('turns away a callback with another state', async () => {
    const forger = join(dir, 'forger')
    writeFileSync(
      forger,
      `#!${process.execPath}\n` +
        'const back = new URL(process.argv[2]).searchParams.get("redirect_uri")\n' +
        'fetch(back + "?code=forged&state=other").then(async (r) => {\n' +
        `  require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'forged'))}, String(r.status))\n` +
        '  const done = await fetch(process.argv[2])\n' +
        '  process.exit(done.ok ? 0 : 1)\n' +
        '})\n',
    )
    chmodSync(forger, 0o755)
    vi.stubEnv('BROWSER', forger)
    const login = await browserLogin(clerk.url)
    expect(readFileSync(join(dir, 'forged'), 'utf-8')).toBe('404')
    expect(login?.refresh_token).toBe('r1')
  })

  it('needs no login on a server that publishes none', async () => {
    const quiet = await new FakeClerk({ publishes: false }).start()
    try {
      expect(await browserLogin(quiet.url)).toBeNull()
    } finally {
      await quiet.stop()
    }
    expect(opened()).toEqual([])
  })

  it('needs no login on a local server that is down', async () => {
    const down = await new FakeClerk().start()
    await down.stop()
    expect(await browserLogin(down.url)).toBeNull()
  })

  it('fails when the user turns it down', async () => {
    const denying = await new FakeClerk({ deny: true }).start()
    try {
      await expect(browserLogin(denying.url)).rejects.toThrow(/access_denied/)
    } finally {
      await denying.stop()
    }
  })

  it('refuses metadata naming another issuer', async () => {
    const other = await new FakeClerk({ issuer: 'https://elsewhere.test' }).start()
    try {
      await expect(browserLogin(other.url)).rejects.toThrow(/another issuer/)
    } finally {
      await other.stop()
    }
    expect(opened()).toEqual([])
  })

  it('puts the well-known path before the issuer path', () => {
    expect(metadataUrl('https://clerk.example.com')).toBe(
      'https://clerk.example.com/.well-known/oauth-authorization-server',
    )
    expect(metadataUrl('https://auth.example.com/tenant/')).toBe(
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
    )
  })

  it('keeps a pasted token once the server takes it', async () => {
    const login = await tokenLogin(clerk.url, 'good')
    expect(login.access_token).toBe('good')
    expect(login.refresh_token).toBeNull()
    await expect(tokenLogin(clerk.url, 'bad')).rejects.toThrow(LoginError)
    await expect(tokenLogin(clerk.url, 'boom')).rejects.toThrow(/answered 500/)
  })

  it('reads a dash token from stdin', async () => {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([Buffer.from('good\n')]) as unknown as typeof process.stdin,
    )
    const done = await run(['login', '--token', '-'])
    expect(done.exitCode).toBe(0)
    expect(readLogin()?.access_token).toBe('good')
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([]) as unknown as typeof process.stdin,
    )
    const empty = await run(['login', '--token', '-'])
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toContain('no token on stdin')
  })

  it('logs in, says who, and logs out', async () => {
    const done = await run(['login'])
    expect(done.exitCode).toBe(0)
    expect(done.stdout).toContain(`Logged in to ${clerk.url} as user_alice.`)
    expect(readLogin()?.refresh_token).toBe('r1')
    const who = await run(['whoami'])
    expect(who.exitCode).toBe(0)
    expect((JSON.parse(who.stdout) as { account: string }).account).toBe('user_alice')
    const out = await run(['logout'])
    expect(out.stdout).toBe(`Logged out of ${clerk.url}.\n`)
    expect(readLogin()).toBeNull()
    expect((await run(['whoami'])).exitCode).toBe(1)
  })

  it('whoami ignores a login for another server', async () => {
    writeLogin({ ...(await tokenLogin(clerk.url, 'good')), url: 'https://elsewhere.test' })
    const who = await run(['whoami'])
    expect(who.exitCode).toBe(1)
    expect(who.stderr).toContain(`not logged in to ${clerk.url}`)
  })

  it('says so on a server without a login', async () => {
    const quiet = await new FakeClerk({ publishes: false }).start()
    vi.stubEnv('MIRAGE_DAEMON_URL', quiet.url)
    try {
      const done = await run(['login'])
      expect(done.exitCode).toBe(0)
      expect(done.stdout).toContain('publishes no login')
    } finally {
      await quiet.stop()
    }
    expect(readLogin()).toBeNull()
  })
})
