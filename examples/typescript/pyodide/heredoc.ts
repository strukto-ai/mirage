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

  console.log('python3 heredoc patterns (commonly emitted by AI agents)\n')

  console.log("=== python3 << 'PYEOF' — quoted delimiter, $X stays literal ===")
  await ws.execute('export X=shellval')
  const quoted = await ws.execute(
    "python3 << 'PYEOF'\nx = '$X'  # literal, not expanded\nprint(x)\nPYEOF",
  )
  console.log(`stdout: ${quoted.stdoutText.trim()}  (expected: '$X')\n`)

  console.log('=== python3 << PYEOF — unquoted delimiter, $X expanded by shell ===')
  const unquoted = await ws.execute("python3 << PYEOF\nprint('$X')\nPYEOF")
  console.log(`stdout: ${unquoted.stdoutText.trim()}  (expected: 'shellval')\n`)

  console.log('=== python3 <<-PYEOF — dash strips leading tabs ===')
  const dashStripped = await ws.execute(
    'python3 <<-PYEOF\n\tfor i in range(3):\n\t    print(f"item-{i}")\n\tPYEOF',
  )
  console.log(`stdout:\n${dashStripped.stdoutText.trim()}\n`)

  console.log('=== python3 << EOF | grep keep — heredoc feeding a pipeline ===')
  const piped = await ws.execute(
    "python3 << EOF | grep keep\nfor i in range(5):\n    print('keep' if i % 2 else 'drop', i)\nEOF",
  )
  console.log(`stdout:\n${piped.stdoutText.trim()}\n`)

  console.log('=== heredoc inside for-loop — body re-fires per iteration ===')
  const loop = await ws.execute(
    "for name in alice bob carol; do python3 <<-PYEOF\n\tname = '$name'\n\tprint(f'hello, {name}!')\n\tPYEOF\ndone",
  )
  console.log(`stdout:\n${loop.stdoutText.trim()}\n`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
