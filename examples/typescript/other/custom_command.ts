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
import {
  command,
  DiskResource,
  IOResult,
  MountMode,
  type PathSpec,
  RAMResource,
  ResourceName,
  specOf,
  Workspace,
} from '@struktoai/mirage-node'

const ENC = new TextEncoder()

const greet = command({
  name: 'greet',
  resource: [ResourceName.RAM, ResourceName.DISK],
  spec: specOf('cat'),
  fn: (accessor, paths: readonly PathSpec[]) => {
    const backend = accessor.constructor.name
    const targets = paths.length > 0 ? paths.map((p) => p.virtual).join(', ') : '(no paths)'
    const body = ENC.encode(`hello from ${backend}: ${targets}\n`)
    return [body, new IOResult()]
  },
})

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mirage-custom-cmd-'))
  writeFileSync(join(tmpRoot, 'note.txt'), 'disk file\n')

  const ws = new Workspace(
    {
      '/ram/': new RAMResource(),
      '/disk/': new DiskResource({ root: tmpRoot }),
    },
    { mode: MountMode.WRITE },
  )

  console.log('=== bindings on greet ===')
  for (const rc of greet) {
    console.log(`  resource='${rc.resource ?? ''}'  name='${rc.name}'`)
  }

  ws.mount('/ram/')?.registerFns(greet)
  ws.mount('/disk/')?.registerFns(greet)

  await ws.execute('echo content > /ram/note.txt')

  console.log('\n=== greet on /ram/ (RAMAccessor wins) ===')
  const ramRes = await ws.execute('greet /ram/note.txt')
  process.stdout.write(ramRes.stdoutText)

  console.log('=== greet on /disk/ (DiskAccessor wins) ===')
  const diskRes = await ws.execute('greet /disk/note.txt')
  process.stdout.write(diskRes.stdoutText)

  await ws.close()
  rmSync(tmpRoot, { recursive: true, force: true })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
