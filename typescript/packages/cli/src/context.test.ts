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

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextError,
  checkName,
  currentName,
  localUrl,
  loginPath,
  readContexts,
  resolveWorkspace,
  writeContexts,
} from './context.ts'
import { readLogin, writeLogin, type Login } from './credentials.ts'
import { buildProgram } from './main.ts'
import { loadDaemonSettings } from './settings.ts'

function stored(url: string, token = 'from-login'): Login {
  return {
    url,
    access_token: token,
    logged_in_at: Date.now() / 1000,
    refresh_token: null,
    expires_at: null,
    client_id: null,
    token_endpoint: null,
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
  try {
    await buildProgram().exitOverride().parseAsync(args, { from: 'user' })
  } catch (e) {
    if (e instanceof ContextError) {
      stderr += e.message
      exitCode = 2
    } else if (!(e instanceof Error) || e.message !== '__exit__') throw e
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { stdout, stderr, exitCode }
}

describe('contexts', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-context-'))
    vi.stubEnv('MIRAGE_HOME', dir)
    for (const name of [
      'MIRAGE_CONTEXT',
      'MIRAGE_WORKSPACE',
      'MIRAGE_DAEMON_URL',
      'MIRAGE_DAEMON_PORT',
      'MIRAGE_TOKEN',
    ]) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('has only local, current, with no file', () => {
    const contexts = readContexts()
    expect(Object.keys(contexts.contexts)).toEqual(['local'])
    expect(currentName(contexts)).toBe('local')
  })

  it('takes $MIRAGE_CONTEXT over the file, and refuses an unknown one', () => {
    writeContexts({
      current: 'local',
      contexts: { dev: { url: 'https://dev.example', team: null, workspace: null } },
    })
    vi.stubEnv('MIRAGE_CONTEXT', 'dev')
    expect(currentName(readContexts())).toBe('dev')
    vi.stubEnv('MIRAGE_CONTEXT', 'nope')
    expect(() => currentName(readContexts())).toThrow(/no context 'nope'/)
  })

  it('keeps the file to its owner', () => {
    writeContexts(readContexts())
    expect(statSync(join(dir, 'contexts.json')).mode & 0o777).toBe(0o600)
  })

  it('refuses a name that is no safe file name', () => {
    expect(checkName('dev.example-1')).toBe('dev.example-1')
    expect(() => checkName('../up')).toThrow(ContextError)
    expect(() => checkName('Dev')).toThrow(ContextError)
  })

  it('follows the daemon port for local, after its own URL and config.toml', () => {
    const contexts = readContexts()
    expect(localUrl({}, contexts)).toBe('http://127.0.0.1:8765')
    expect(localUrl({ port: '9100' }, contexts)).toBe('http://127.0.0.1:9100')
    vi.stubEnv('MIRAGE_DAEMON_PORT', '9200')
    expect(localUrl({ port: '9100' }, contexts)).toBe('http://127.0.0.1:9200')
    expect(localUrl({ url: 'http://127.0.0.1:9300' }, contexts)).toBe('http://127.0.0.1:9300')
    const own = {
      ...contexts,
      contexts: { local: { url: 'http://127.0.0.1:9400', team: null, workspace: null } },
    }
    expect(localUrl({ url: 'http://127.0.0.1:9300' }, own)).toBe('http://127.0.0.1:9400')
  })

  it("moves a login kept before contexts to local's", () => {
    writeFileSync(join(dir, 'login.json'), JSON.stringify(stored('http://127.0.0.1:8765')))
    const path = loginPath('local')
    expect(path).toBe(join(dir, 'logins', 'local.json'))
    expect(existsSync(join(dir, 'login.json'))).toBe(false)
    expect(readLogin(path)?.access_token).toBe('from-login')
  })

  it("sends a remote context's login there, and never config.toml's token", () => {
    writeFileSync(join(dir, 'config.toml'), '[daemon]\nauth_token = "local-only"\n')
    writeContexts({
      current: 'dev',
      contexts: { dev: { url: 'https://dev.example', team: 'acme', workspace: null } },
    })
    expect(loadDaemonSettings().authToken).toBe('')
    writeLogin(stored('https://dev.example'), loginPath('dev'))
    const settings = loadDaemonSettings()
    expect(settings).toMatchObject({ context: 'dev', url: 'https://dev.example', authToken: '' })
    expect(settings.login?.access_token).toBe('from-login')
  })

  it('picks the workspace from -w, then $MIRAGE_WORKSPACE, then the context', () => {
    writeContexts({
      current: 'local',
      contexts: { local: { url: '', team: null, workspace: 'kept' } },
    })
    expect(resolveWorkspace(undefined)).toBe('kept')
    vi.stubEnv('MIRAGE_WORKSPACE', 'env')
    expect(resolveWorkspace(undefined)).toBe('env')
    expect(resolveWorkspace('flag')).toBe('flag')
  })

  it('fails with a hint when no workspace is selected', async () => {
    const done = await run(['shell', '-c', 'true'])
    expect(done.exitCode).toBe(2)
    expect(done.stderr).toContain('run `mirage workspace use <id>` or pass -w')
  })

  it('switches, runs one command elsewhere, and forgets a context', async () => {
    writeContexts({
      current: 'local',
      contexts: { dev: { url: 'https://dev.example', team: 'acme', workspace: 'w1' } },
    })
    writeLogin(stored('https://dev.example'), loginPath('dev'))
    const once = await run(['--context', 'dev', 'whoami'])
    expect(JSON.parse(once.stdout)).toMatchObject({
      context: 'dev',
      url: 'https://dev.example',
      team: 'acme',
      workspace: 'w1',
    })
    expect(readContexts().current).toBe('local')
    expect((await run(['context', 'use', 'dev'])).exitCode).toBe(0)
    expect(readContexts().current).toBe('dev')
    expect((await run(['context', 'use', 'nope'])).exitCode).toBe(2)
    expect((await run(['context', 'delete', 'local'])).exitCode).toBe(2)
    expect((await run(['context', 'delete', 'dev'])).exitCode).toBe(0)
    expect(readContexts()).toMatchObject({ current: 'local' })
    expect(existsSync(join(dir, 'logins', 'dev.json'))).toBe(false)
  })

  it('warns that config moved, and that url leaves config.toml', async () => {
    const done = await run(['config', 'set', 'url', 'http://127.0.0.1:9'])
    expect(done.stderr).toContain('`mirage config` moved to `mirage daemon config`')
    expect(done.stderr).toContain('url leaves config.toml in the next release')
    expect(readFileSync(join(dir, 'config.toml'), 'utf-8')).toContain('url = "http://127.0.0.1:9"')
    const daemon = await run(['daemon', 'config', 'get', 'url'])
    expect(daemon.stderr).toBe('')
    expect(JSON.parse(daemon.stdout)).toEqual({ url: 'http://127.0.0.1:9' })
  })
})
