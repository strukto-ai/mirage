import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as github from '../../../../core/github/repo.ts'
import { IOResult } from '../../../../io/types.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import type { ExecuteResult } from '../../../../workspace/workspace/types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import type { Context } from '../../../config.ts'
import * as git from '../git/clone.ts'
import { GH } from './index.ts'

const WORK = PathSpec.fromStrPath('/w')
const TOKEN = { Authorization: `Basic ${btoa('x-access-token:secret-never-print')}` }
const ATTACKER = 'https://attacker.example/x.git'

const require = createRequire(import.meta.url)
let parser: ShellParser
beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
})
afterEach(() => vi.restoreAllMocks())

function clones(): [string[], Context, Readonly<Record<string, string>> | undefined][] {
  const calls: [string[], Context, Readonly<Record<string, string>> | undefined][] = []
  vi.spyOn(github, 'login').mockResolvedValue('alice')
  vi.spyOn(git, 'clone').mockImplementation((_config, _paths, texts, ctx, credentials) => {
    calls.push([texts, ctx, credentials])
    return Promise.resolve([null, new IOResult()])
  })
  return calls
}

async function run(line: string, base?: string): Promise<ExecuteResult> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
  ws.registerCli('gh', GH, {
    token: 'secret-never-print',
    ...(base === undefined ? {} : { base_url: base }),
  })
  try {
    return await ws.shell(line)
  } finally {
    await ws.close()
  }
}

it.each([
  ['cd /w && gh repo clone o/r', undefined, ['https://github.com/o/r.git'], { C: WORK }],
  [
    'cd /w && gh repo clone https://github.com/o/r.git dest',
    undefined,
    ['https://github.com/o/r.git', 'dest'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone mine -- -q --branch dev',
    undefined,
    ['https://github.com/alice/mine.git'],
    { quiet: true, branch: 'dev', C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'https://ghe.test/api/v3',
    ['https://ghe.test/o/r.git'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'https://GHE.test:443/api/v3',
    ['https://ghe.test/o/r.git'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r -- -q https://ghe.test/o/x.git',
    'https://ghe.test:443/api/v3',
    ['https://ghe.test/o/x.git', 'https://ghe.test/o/r.git'],
    { quiet: true, C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'https://u:p@ghe.test/api/v3',
    ['https://ghe.test/o/r.git'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'http://ghe.test:80/api/v3',
    ['http://ghe.test/o/r.git'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'http://ghe.test:443/api/v3',
    ['http://ghe.test:443/o/r.git'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone o/r',
    'http://[::1]:8080/api/v3',
    ['http://[::1]:8080/o/r.git'],
    { C: WORK },
  ],
])('hands git clone the url and flags of %s', async (line, base, texts, flags) => {
  const calls = clones()
  const result = await run(line, base)
  expect([result.exitCode, result.stderr.length]).toEqual([0, 0])
  expect([calls[0]?.[0], calls[0]?.[1].flags, calls[0]?.[2]]).toEqual([texts, flags, TOKEN])
})

it.each([
  'ghe.test/api/v3',
  '//ghe.test/api/v3',
  'ghe.test:8080/api/v3',
  'http://:8080/api/v3',
  'git://ghe.test/api/v3',
  'https://ghe.test:99999/api/v3',
  'https://ghe.test:abc/api/v3',
])(
  'refuses an API base that is not an http(s) URL with a host on gh repo clone: %s',
  async (base) => {
    const calls = clones()
    const result = await run('cd /w && gh repo clone o/r', base)
    expect([result.exitCode, new TextDecoder().decode(result.stderr), calls]).toEqual([
      1,
      'gh repo clone: Invalid URL\n',
      [],
    ])
  },
)

it.each([
  [
    'cd /w && gh repo clone o/r -- mydir',
    ['https://github.com/o/r.git', 'mydir'],
    { C: WORK },
    TOKEN,
  ],
  ["cd /w && gh repo clone o/r ''", ['https://github.com/o/r.git'], { C: WORK }, TOKEN],
  [
    "cd /w && gh repo clone o/r '' -- extra",
    ['extra', 'https://github.com/o/r.git'],
    { C: WORK },
    {},
  ],
  [
    'cd /w && gh repo clone o/r -- -b dev',
    ['https://github.com/o/r.git'],
    { branch: 'dev', C: WORK },
    TOKEN,
  ],
  [
    `cd /w && gh repo clone o/r -- ${ATTACKER}`,
    ['https://github.com/o/r.git', ATTACKER],
    { C: WORK },
    TOKEN,
  ],
  [
    `cd /w && gh repo clone o/r -- -q ${ATTACKER}`,
    [ATTACKER, 'https://github.com/o/r.git'],
    { quiet: true, C: WORK },
    {},
  ],
  [
    `cd /w && gh repo clone o/r ${ATTACKER} -- -b`,
    [ATTACKER],
    { branch: 'https://github.com/o/r.git', C: WORK },
    {},
  ],
  [
    'cd /w && gh repo clone o/r -- -q https://github.com.attacker.example/x.git',
    ['https://github.com.attacker.example/x.git', 'https://github.com/o/r.git'],
    { quiet: true, C: WORK },
    {},
  ],
  [
    'cd /w && gh repo clone o/r -- -q http://github.com/o/r.git',
    ['http://github.com/o/r.git', 'https://github.com/o/r.git'],
    { quiet: true, C: WORK },
    {},
  ],
  [
    'cd /w && gh repo clone o/r -- -q https://github.com/other/x.git',
    ['https://github.com/other/x.git', 'https://github.com/o/r.git'],
    { quiet: true, C: WORK },
    TOKEN,
  ],
  [
    'cd /w && gh repo clone o/r dir -- extra',
    ['extra', 'https://github.com/o/r.git', 'dir'],
    { C: WORK },
    {},
  ],
])('sends the token only to the install origin: %s', async (line, texts, flags, credentials) => {
  const calls = clones()
  const result = await run(line)
  expect([result.exitCode, result.stderr.length]).toEqual([0, 0])
  expect([calls[0]?.[0], calls[0]?.[1].flags, calls[0]?.[2]]).toEqual([texts, flags, credentials])
})
