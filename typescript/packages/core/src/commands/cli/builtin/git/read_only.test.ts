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

import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { VERSION } from '../../../../version.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/read-only.sh', import.meta.url),
)
const DEC = new TextDecoder()

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let tmp: string
let repoPath: string
let ws: Workspace
let parser: ShellParser

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** What the real git binary prints for the same line, as the truth to match. */

async function run(line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-'))
  repoPath = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repoPath], { stdio: 'ignore' })

  const ram = new RAMVFS()
  parser = await createShellParser({ engineWasm, grammarWasm })
  ws = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, shellParser: parser })
  const dispatch: Dispatch = async (op, path, args = [], kwargs = {}) => [
    await ws.dispatch(op, path.virtual, args, kwargs),
    new IOResult(),
  ]
  for (const rel of walk(repoPath)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repoPath, rel)))])
  }
  ws.registerCli('git', GIT)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const forms = JSON.parse(readFileSync(BUILDER.replace('.sh', '.json'), 'utf8')) as string[]
it.each(forms)('matches native Git: %s', async (form) => {
  const native = spawnSync('bash', ['-c', `git -C "$1" ${form}`, 'native-git', repoPath], {
    env: {
      ...process.env,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
  })
  expect(await run(form)).toEqual([native.status, native.stdout, native.stderr])
})

// A named commit always shows its header, even when the pathspec leaves no
// diff (git 2.55 in CI; Apple's git 2.54 drops the commit, so these stay out
// of the native list).
it.each([
  ['show --format=%s --name-status HEAD~1 -- nothing', 'add app\n'],
  ['show --format=%s --name-status HEAD -- app.txt', 'merge side\n\n'],
  ['show --format=%s --first-parent --name-status HEAD -- app.txt', 'merge side\n'],
])('keeps a named commit header: %s', async (form, stdout) => {
  expect(await run(form)).toEqual([0, stdout, ''])
})
it.each(['--version', 'version', '-v'])('version without repository: %s', async (form) => {
  const r = await ws.shell('git ' + form)
  expect(r.exitCode).toBe(0)
  expect(DEC.decode(r.stdout)).toBe(`git version ${VERSION} (Mirage)\n`)
})

it.each(['', '--find-renames', '--no-renames'])(
  'honors diff.renames and explicit override: %s',
  async (flag) => {
    const original = readFileSync(join(repoPath, '.git/config'))
    await ws.dispatch('write', '/repo/.git/config', [
      new TextEncoder().encode(DEC.decode(original) + '\n[diff]\nrenames = false\n'),
    ])
    try {
      const args = ['show', '--format=', '--name-status', ...(flag ? [flag] : []), 'HEAD~2']
      const native = spawnSync('git', ['-C', repoPath, '-c', 'diff.renames=false', ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          LC_ALL: 'C',
          LANG: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
      expect(await run(args.join(' '))).toEqual([native.status, native.stdout, native.stderr])
    } finally {
      await ws.dispatch('write', '/repo/.git/config', [new Uint8Array(original)])
    }
  },
)
