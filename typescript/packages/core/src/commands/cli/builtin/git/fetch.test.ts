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

import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { ignoreFunny, prettify, summaryLines, type Wanted } from './fetch.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const SCENARIO = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/remote.sh', import.meta.url),
)
const DEC = new TextDecoder()
const ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@example.com',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
}
// macOS git writes these two into every new repository's config.
const HOST_ONLY = '\tignorecase = true\n\tprecomposeunicode = true\n'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let tmp: string
let native: string
let seed: string
let ws: Workspace
let parser: ShellParser

/** Every file and directory under a root, directories with a trailing slash. */
function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const rel = relative(base, full).split(sep).join('/')
    if (statSync(full).isDirectory()) out.push(`${rel}/`, ...walk(full, base))
    else out.push(rel)
  }
  return out
}

/** Copy one directory of the seed tree into the RAM mount, replacing it. */
async function load(name: string): Promise<void> {
  await ws.shell(`rm -rf /w/${name}`)
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  await ensureDir(dispatch, PathSpec.fromStrPath(`/w/${name}`))
  for (const rel of walk(join(seed, name))) {
    const target = `/w/${name}/${rel}`
    if (rel.endsWith('/')) await ensureDir(dispatch, PathSpec.fromStrPath(target.slice(0, -1)))
    else await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(seed, name, rel)))])
  }
}

function localized(root: string, text: string): string {
  let out = text
  for (const path of [realpathSync(root), root]) out = out.split(path).join('/w')
  return out.split(HOST_ONLY).join('')
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-remote-'))
  native = join(tmp, 'native')
  seed = join(tmp, 'seed')
  execFileSync('bash', [SCENARIO, native], { stdio: 'ignore', env: ENV })
  cpSync(native, seed, { recursive: true })
  const ram = new RAMVFS()
  parser = await createShellParser({ engineWasm, grammarWasm })
  ws = new Workspace({ '/w': ram }, { mode: MountMode.WRITE, shellParser: parser })
  ws.registerCli('git', GIT)
  for (const name of readdirSync(seed)) await load(name)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

it('drops a ref git refuses to name locally, with its error', () => {
  const oid = 'a'.repeat(40)
  const want = (remote: string, local: string | null): Wanted => ({
    remote,
    oid,
    local,
    force: false,
    merge: false,
    listed: true,
  })
  const wants = [
    want('refs/heads/main', 'refs/remotes/o/main'),
    want('refs/tags/../../x', 'refs/tags/../../x'),
    want('refs/heads/main', 'HEAD'),
    want('HEAD', null),
  ]
  expect(ignoreFunny(wants)).toEqual([
    [wants[0], wants[3]],
    "error: * Ignoring funny ref 'refs/tags/../../x' locally\n" +
      "error: * Ignoring funny ref 'HEAD' locally\n",
  ])
})

it('strips the three namespaces when prettifying', () => {
  expect(['refs/heads/a', 'refs/tags/b', 'refs/remotes/o/c', 'HEAD'].map(prettify)).toEqual([
    'a',
    'b',
    'o/c',
    'HEAD',
  ])
})

it('widens the summary columns for a long ref', () => {
  expect(
    summaryLines(
      '/w/src.git/',
      [
        {
          code: '*',
          summary: '[new branch]',
          remote: 'a-very-long-branch-name',
          local: 'o/x',
          error: '',
          counted: true,
        },
        {
          code: ' ',
          summary: '1234567..89abcde',
          remote: 'main',
          local: 'o/main',
          error: '',
          counted: true,
        },
      ],
      7,
    ),
  ).toBe(
    'From /w/src\n' +
      ' * [new branch]      a-very-long-branch-name -> o/x\n' +
      '   1234567..89abcde  main                    -> o/main\n',
  )
})

it('clones and fetches between workspace repositories as native git does', async () => {
  const steps = JSON.parse(readFileSync(SCENARIO.replace('.sh', '.json'), 'utf8')) as string[]
  for (const step of steps) {
    if (step.startsWith('!')) {
      for (const root of [native, seed])
        execFileSync('bash', ['-ec', step.slice(1)], { cwd: root, env: ENV, stdio: 'ignore' })
      await load('src')
      continue
    }
    const want = spawnSync('bash', ['-c', step], { cwd: native, env: ENV, encoding: 'utf8' })
    const got = await ws.shell(`cd /w && ${step}`)
    expect([got.exitCode, DEC.decode(got.stdout), DEC.decode(got.stderr)], step).toEqual([
      want.status,
      localized(native, want.stdout),
      localized(native, want.stderr),
    ])
  }
}, 120_000)
