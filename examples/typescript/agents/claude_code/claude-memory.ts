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

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import { FuseManager, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const { values } = parseArgs({
  options: {
    prompt: { type: 'string', default: 'write a hello world script in hello.py' },
  },
})

const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
const fm = new FuseManager()
const mountpoint = await fm.setup(ws)
console.log(`Mounted memory filesystem at ${mountpoint}`)

try {
  // This process's event loop serves the mount, and spawn() holds that
  // loop until the child has exec'd, so the child must not chdir into the
  // mount before exec. Start it outside and let a shell cd in.
  const claude = spawn(
    '/bin/sh',
    ['-c', 'cd "$0" && exec claude -p "$1"', mountpoint, values.prompt],
    { stdio: 'inherit' },
  )
  await once(claude, 'close')
} finally {
  await fm.unmount()
}

console.log('\n=== Files Claude created (in memory) ===')
for (const path of await ws.vfs.readdir('/')) {
  if (await ws.vfs.isDir(path)) {
    console.log(`\n--- ${path}/ (directory) ---`)
    continue
  }
  const content = await ws.vfs.read(path)
  console.log(`\n--- ${path} (${String(content.byteLength)} bytes) ---`)
  console.log(new TextDecoder().decode(content))
}
await ws.close()
