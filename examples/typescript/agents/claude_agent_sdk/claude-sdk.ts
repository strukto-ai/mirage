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

// Use the Claude Agent SDK with a Mirage FUSE-backed workspace.
//
// The agent reads, writes, and edits files, all intercepted by Mirage's
// FUSE layer. Every file operation is recorded and can be inspected after
// the agent finishes.
//
// Usage:
//   pnpm --filter @struktoai/mirage-examples exec \
//     tsx agents/claude_agent_sdk/claude-sdk.ts
//   pnpm --filter @struktoai/mirage-examples exec \
//     tsx agents/claude_agent_sdk/claude-sdk.ts \
//     --prompt "create a python calculator module with tests"

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { query, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { FuseManager, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const { values } = parseArgs({
  options: {
    prompt: {
      type: 'string',
      default:
        "Create a file called /hello.py that prints 'Hello from Mirage!' " +
        'and a file called /utils.py with a function that reverses a string.',
    },
  },
})
const prompt = values.prompt

// This process's event loop serves the mount, and spawn() holds that loop
// until the child has exec'd, so the child must not chdir into the mount
// before exec. Start it outside and let a shell cd in.
function spawnInMount({ command, args, cwd, env, signal }: SpawnOptions): SpawnedProcess {
  return spawn('/bin/sh', ['-c', 'cd "$0" && exec "$@"', cwd ?? '.', command, ...args], {
    env,
    signal,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

async function printWorkspace(ws: Workspace, prefix = '/'): Promise<void> {
  for (const path of await ws.vfs.readdir(prefix)) {
    if (await ws.vfs.isDir(path)) {
      console.log(`\n--- ${path}/ (directory) ---`)
      continue
    }
    const content = await ws.vfs.read(path)
    console.log(`\n--- ${path} (${String(content.byteLength)} bytes) ---`)
    console.log(new TextDecoder().decode(content))
  }
}

function printOps(ops: Workspace['records']): void {
  for (const op of ops) {
    console.log(`  [${String(op.timestamp)}] ${op.op.padEnd(6)}  ${op.path}`)
  }
}

const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
const fm = new FuseManager()
const mountpoint = await fm.setup(ws)
console.log(`Mounted memory workspace at ${mountpoint}`)
console.log(`Prompt: ${prompt}\n`)

let ops: Workspace['records'] = []
try {
  for await (const message of query({
    prompt,
    options: {
      cwd: mountpoint,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      spawnClaudeCodeProcess: spawnInMount,
    },
  })) {
    if (message.type === 'result' && message.subtype === 'success') {
      console.log(`\n=== Agent result ===\n${message.result}`)
    }
  }
} finally {
  ops = [...ws.records]
  await fm.unmount()
}

console.log('\n=== FUSE operations captured ===')
if (ops.length > 0) {
  printOps(ops)
} else {
  console.log('  (no operations recorded)')
}

console.log('\n=== Files in workspace (all in-memory) ===')
await printWorkspace(ws)
await ws.close()
