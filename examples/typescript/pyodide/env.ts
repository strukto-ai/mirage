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

import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

async function main(): Promise<void> {
  const ws = new Workspace({ '/ram': new RAMResource() }, { mode: MountMode.EXEC })

  console.log('python3 + session env (os.environ passthrough)\n')

  console.log('=== export FOO=bar; python3 reads os.environ ===')
  await ws.execute('export FOO=bar')
  const r1 = await ws.execute("python3 -c \"import os; print(os.environ.get('FOO', 'missing'))\"")
  console.log(`stdout: ${r1.stdoutText.trim()}  (expected: bar)\n`)

  console.log('=== mutations inside python3 do NOT flow back to session.env ===')
  await ws.execute("python3 -c \"import os; os.environ['FOO'] = 'mutated_inside_python'\"")
  const r2 = await ws.execute('python3 -c "import os; print(os.environ[\'FOO\'])"')
  console.log(
    `stdout: ${r2.stdoutText.trim()}  (expected: bar — previous mutation died with the call)\n`,
  )

  console.log('=== isolation across workspaces — each has its own Pyodide ===')
  const wsA = new Workspace({ '/ram': new RAMResource() }, { mode: MountMode.EXEC })
  const wsB = new Workspace({ '/ram': new RAMResource() }, { mode: MountMode.EXEC })
  await wsA.execute('export NAME=alice')
  await wsB.execute('export NAME=bob')

  // Fire python3 in both workspaces concurrently — each has its own Pyodide,
  // so envs are strictly isolated even while they run in parallel.
  const [aliceOut, bobOut] = await Promise.all([
    wsA.execute('python3 -c "import os; print(os.environ.get(\'NAME\'))"'),
    wsB.execute('python3 -c "import os; print(os.environ.get(\'NAME\'))"'),
  ])
  console.log(`wsA:  ${aliceOut.stdoutText.trim()}  (expected: alice)`)
  console.log(`wsB:  ${bobOut.stdoutText.trim()}  (expected: bob)`)
  console.log('(each workspace has its own Pyodide → own os.environ → no mixing)\n')
  await wsA.close()
  await wsB.close()

  console.log('=== host environment is not inherited ===')
  const key = 'MIRAGE_PYODIDE_HOST_ONLY'
  const previous = process.env[key]
  process.env[key] = 'host-marker'
  try {
    const command = `python3 -c "import os; print(os.environ.get('${key}', 'missing'))"`
    const isolated = await ws.execute(command)
    console.log(`host-only value: ${isolated.stdoutText.trim()}  (expected: missing)`)
    const explicit = await ws.execute(command, {
      env: { [key]: 'guest-marker' },
    })
    console.log(`explicit command value: ${explicit.stdoutText.trim()}  (expected: guest-marker)\n`)
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
