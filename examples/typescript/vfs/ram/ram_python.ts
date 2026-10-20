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

import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

async function stdout(ws: Workspace, cmd: string): Promise<string> {
  const res = await ws.shell(cmd)
  return res.stdoutText.trim()
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.EXEC })

  console.log('=== python3 -c (basic) ===')
  console.log(`stdout: ${await stdout(ws, 'python3 -c "print(42)"')}  (expected: 42)`)

  // The default monty runtime exposes command-line args as the `argv`
  // global; `sys.argv` exists under the `local` runtime.
  console.log('\n=== python3 -c with argv (flag-conditional) ===')
  console.log(
    `argv after -c: ${await stdout(ws, 'python3 -c "print(argv[1:])" alpha beta')}  ` +
      `(expected: ['alpha', 'beta'])`,
  )

  console.log('\n=== python3 /ram/script.py (abs path → dispatch read) ===')
  await ws.shell(`echo 'print("hello from vfs")' > /ram/h.py`)
  console.log(`stdout: ${await stdout(ws, 'python3 /ram/h.py')}  (expected: hello from vfs)`)

  console.log('\n=== python3 /abs/script.py arg1 arg2 (script + argv) ===')
  await ws.shell(`echo 'print(argv[1:])' > /ram/argv.py`)
  console.log(
    `argv after script: ${await stdout(ws, 'python3 /ram/argv.py one two')}  ` +
      `(expected: ['one', 'two'])`,
  )

  console.log('\n=== python3 bare-name script via cwd ===')
  console.log(`stdout: ${await stdout(ws, 'cd /ram && python3 h.py')}  (expected: hello from vfs)`)

  console.log('\n=== echo code | python3 (stdin) ===')
  console.log(`stdout: ${await stdout(ws, 'echo "print(7*6)" | python3')}  (expected: 42)`)

  console.log('\n=== heredoc ===')
  console.log(`stdout: ${await stdout(ws, 'python3 <<PYEOF\nprint(1 + 2)\nPYEOF')}  (expected: 3)`)

  console.log('\n=== session env passthrough ===')
  await ws.shell('export GREETING=hello_mirage')
  const env = await stdout(
    ws,
    `python3 -c "import os; print(os.environ.get('GREETING','none'))"`,
  )
  console.log(`stdout: ${env}  (expected: hello_mirage)`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
