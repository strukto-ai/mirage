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

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)

let parser: ShellParser
let fixture: string

beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
  fixture = join(mkdtempSync(join(tmpdir(), 'mirage-git-session-')), 'repo')
  execFileSync('bash', [BUILDER, fixture], { stdio: 'ignore' })
})

afterAll(() => {
  rmSync(dirname(fixture), { recursive: true, force: true })
})

async function load(ws: Workspace, root: string, relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.shell(`mkdir -p /repo/${name}`)
      await load(ws, root, name)
    } else await ws.dispatch('write', `/repo/${name}`, [readFileSync(join(root, name))])
  }
}

it('keeps the error of a read-only work tree', async () => {
  const repo = new RAMVFS()
  const tree = new RAMVFS()
  const writer = new Workspace(
    { '/repo': repo, '/tree': tree },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  await load(writer, fixture)
  await writer.shell("printf 'edited\\n' > /tree/letters.txt")
  const ws = new Workspace(
    { '/repo': [repo, MountMode.WRITE], '/tree': [tree, MountMode.READ] },
    { shellParser: parser },
  )
  ws.registerCli('git', GIT)
  const result = await ws.shell(
    'git --git-dir=/repo/.git --work-tree=/tree restore --source=HEAD~1 letters.txt',
  )
  const err = DEC.decode(result.stderr)
  expect(result.exitCode).toBe(1)
  expect(err).toContain('/tree/')
  expect(err).not.toContain('index.lock')
})
