import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GitHubApiError } from '../../../../core/github/client.ts'
import * as repo from '../../../../core/github/repo.ts'
import { GH } from './index.ts'

const require = createRequire(import.meta.url)
let parser: ShellParser
beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
})
afterEach(() => vi.restoreAllMocks())
it.each([
  [undefined, 'github.com'],
  ['https://enterprise.test/api/v3', 'enterprise.test'],
])('reports the configured account on %s', async (base, host) => {
  const login = vi.spyOn(repo, 'login').mockResolvedValue('alice')
  const ws = new Workspace({}, { shellParser: parser })
  ws.registerCli('gh', GH, {
    token: 'secret-never-print',
    ...(base === undefined ? {} : { base_url: base }),
  })
  try {
    const result = await ws.shell('gh auth status')
    expect(result.exitCode).toBe(0)
    const text = new TextDecoder().decode(result.stdout)
    expect(text.startsWith(host + '\n')).toBe(true)
    expect(text).toContain('account alice (Mirage configuration)')
    expect(text).not.toContain('secret-never-print')
    expect(login).toHaveBeenCalledOnce()
  } finally {
    await ws.close()
  }
})
it('reports a rejected credential with exit 1', async () => {
  vi.spyOn(repo, 'login').mockRejectedValue(new GitHubApiError('Bad credentials', 401))
  const ws = new Workspace({}, { shellParser: parser })
  ws.registerCli('gh', GH, { token: 'secret-never-print' })
  try {
    const result = await ws.shell('gh auth status')
    expect(result.exitCode).toBe(1)
    expect(result.stdout.length).toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('HTTP 401')
    expect(new TextDecoder().decode(result.stderr)).not.toContain('secret-never-print')
  } finally {
    await ws.close()
  }
})

it('refuses gh auth token for the configured host', async () => {
  const ws = new Workspace({}, { shellParser: parser })
  ws.registerCli('gh', GH, { token: 'secret-never-print', base_url: 'https://ghe.test/api/v3' })
  try {
    const result = await ws.shell('gh auth token')
    expect([result.exitCode, result.stdout.length]).toEqual([1, 0])
    expect(new TextDecoder().decode(result.stderr)).toBe(
      'gh auth token: the token for ghe.test stays in Mirage configuration and is never printed; gh commands use it directly\n',
    )
  } finally {
    await ws.close()
  }
})
