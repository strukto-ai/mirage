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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConfigCommands } from './config.ts'

function buildProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerConfigCommands(program)
  return program
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk)
    return true
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error('__exit__')
  }) as never)
  try {
    await buildProgram().parseAsync(['node', 'mirage', ...args])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__exit__') throw e
  } finally {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { stdout, stderr, exitCode }
}

describe('registerConfigCommands', () => {
  let dir: string
  let originalHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-cmd-'))
    originalHome = process.env.MIRAGE_HOME
    process.env.MIRAGE_HOME = dir
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MIRAGE_HOME
    else process.env.MIRAGE_HOME = originalHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers list/get/set/unset subcommands', () => {
    const program = buildProgram()
    const config = program.commands.find((c) => c.name() === 'config')
    expect(config).toBeDefined()
    const sub = config?.commands.map((c) => c.name()).sort() ?? []
    expect(sub).toEqual(['get', 'list', 'set', 'unset'].sort())
  })

  it('set then get returns the written value', async () => {
    const setResult = await run(['config', 'set', 'url', 'http://127.0.0.1:9000'])
    expect(setResult.exitCode).toBe(0)
    const getResult = await run(['config', 'get', 'url'])
    expect(getResult.exitCode).toBe(0)
    const parsed = JSON.parse(getResult.stdout) as Record<string, string>
    expect(parsed.url).toBe('http://127.0.0.1:9000')
  })

  it('list reports every written key', async () => {
    await run(['config', 'set', 'url', 'http://127.0.0.1:9000'])
    await run(['config', 'set', 'idle_grace_seconds', '10'])
    const listResult = await run(['config', 'list'])
    expect(listResult.exitCode).toBe(0)
    const parsed = JSON.parse(listResult.stdout) as Record<string, string>
    expect(parsed).toEqual({ url: 'http://127.0.0.1:9000', idle_grace_seconds: '10' })
  })

  it('unset removes a previously set key', async () => {
    await run(['config', 'set', 'url', 'http://127.0.0.1:9000'])
    const unsetResult = await run(['config', 'unset', 'url'])
    expect(unsetResult.exitCode).toBe(0)
    const getResult = await run(['config', 'get', 'url'])
    expect(getResult.exitCode).toBe(1)
  })

  it('get exits nonzero when the key is unset', async () => {
    const getResult = await run(['config', 'get', 'auth_token'])
    expect(getResult.exitCode).toBe(1)
    expect(getResult.stderr).toContain('auth_token is not set')
  })

  it('rejects an unknown key on get/set with exit code 2', async () => {
    const getResult = await run(['config', 'get', 'MIRAGE_HOME'])
    expect(getResult.exitCode).toBe(2)
    const setResult = await run(['config', 'set', 'MIRAGE_HOME', '/tmp'])
    expect(setResult.exitCode).toBe(2)
  })

  it('unset accepts an unknown key so a broken file can be repaired', async () => {
    const unsetResult = await run(['config', 'unset', 'typo_key'])
    expect(unsetResult.exitCode).toBe(0)
  })
})

describe('config list hardening', () => {
  let dir: string
  let originalHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-cmd2-'))
    originalHome = process.env.MIRAGE_HOME
    process.env.MIRAGE_HOME = dir
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MIRAGE_HOME
    else process.env.MIRAGE_HOME = originalHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('warns on unknown keys without failing', async () => {
    writeFileSync(join(dir, 'config.toml'), '[daemon]\ntypo_key = "x"\n')
    const r = await run(['config', 'list'])
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('typo_key')
    expect(r.stderr.toLowerCase()).toContain('unknown')
  })

  it('fails cleanly on a malformed file', async () => {
    writeFileSync(join(dir, 'config.toml'), '[daemon]\nnot toml\n')
    const r = await run(['config', 'list'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('malformed')
  })

  it('--resolved shows effective values with origins', async () => {
    writeFileSync(join(dir, 'config.toml'), '[daemon]\nport = 9001\n')
    const r = await run(['config', 'list', '--resolved'])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout) as Record<string, { value: string; origin: string }>
    expect(parsed.port).toEqual({ value: '9001', origin: 'file' })
    expect(parsed.url?.origin).toBe('default')
  })

  it('--resolved masks auth_token', async () => {
    writeFileSync(join(dir, 'config.toml'), '[daemon]\nauth_token = "supersecret"\n')
    const r = await run(['config', 'list', '--resolved'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('supersecret')
    expect(r.stdout).toContain('***')
  })
})
