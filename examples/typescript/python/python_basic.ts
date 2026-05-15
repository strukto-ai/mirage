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

const DEC = new TextDecoder()

function print(bytes: Uint8Array): void {
  process.stdout.write(DEC.decode(bytes))
}

async function runLabeled(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`=== ${label} ===`)
  const res = await ws.execute(cmd)
  print(res.stdout)
  if (res.stderr.length > 0) {
    console.error('STDERR:', res.stderrText)
  }
  console.log(`exit: ${String(res.exitCode)}\n`)
}

async function main(): Promise<void> {
  const ram = new RAMResource()
  const ws = new Workspace({ '/data': ram }, { mode: MountMode.EXEC })

  console.log('python3 in @mirage-ai — Pyodide-backed, three invocation modes')
  console.log('(first call takes ~1-2s to boot Pyodide; subsequent calls are instant)\n')

  await runLabeled(ws, 'python3 -c "print(2+3)"', 'python3 -c "print(2+3)"')

  await runLabeled(
    ws,
    'python3 -c with multi-statement code',
    'python3 -c "import json; print(json.dumps({\\"ok\\": True}))"',
  )

  await runLabeled(
    ws,
    'python3 -c with args (sys.argv)',
    'python3 -c "import sys; print(sys.argv[1:])" alpha beta',
  )

  console.log('=== echo "print(1+1)" | python3 (stdin-code mode) ===')
  const stdinRes = await ws.execute('echo "print(1+1)" | python3')
  print(stdinRes.stdout)
  console.log(`exit: ${String(stdinRes.exitCode)}\n`)

  console.log('=== SystemExit honored ===')
  const exitRes = await ws.execute('python3 -c "import sys; sys.exit(3)"')
  console.log(`exit: ${String(exitRes.exitCode)} (expect 3)\n`)

  console.log('=== uncaught exception → traceback on stderr, exit 1 ===')
  const errRes = await ws.execute('python3 -c "raise RuntimeError(\'boom\')"')
  console.log(`exit: ${String(errRes.exitCode)} (expect 1)`)
  console.log(`stderr tail: ${errRes.stderrText.trim().split('\n').slice(-1)[0]}\n`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
