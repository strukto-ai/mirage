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
import { OpsRegistry } from '../../../../ops/registry.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'
import type { Dispatch } from './types.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/refs.sh', import.meta.url),
)
const DEC = new TextDecoder()
// The clock both sides render relative and human dates by.
const CLOCK = 'GIT_TEST_DATE_NOW=1700000000 TZ=UTC'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let tmp: string
let repoPath: string
let ws: Workspace

const NATIVE_ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TEST_DATE_NOW: '1700000000',
  TZ: 'UTC',
}

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-refs-'))
  repoPath = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repoPath], { stdio: 'ignore', env: NATIVE_ENV })
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  const parser = await createShellParser({ engineWasm, grammarWasm })
  ws = new Workspace(
    { '/repo': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
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

/** What the real git binary prints for the same line, as the truth to match. */
function native(form: string): [number | null, string, string] {
  const done = spawnSync('bash', ['-c', `git -C "$1" ${form}`, 'native-git', repoPath], {
    env: NATIVE_ENV,
    encoding: 'utf8',
  })
  return [done.status, done.stdout, done.stderr]
}

const forms = JSON.parse(readFileSync(BUILDER.replace('.sh', '.json'), 'utf8')) as string[]
it.each(forms)('lists refs as native Git: %s', async (form) => {
  const result = await ws.shell(`${CLOCK} git -C /repo ${form}`)
  expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual(
    native(form),
  )
})
