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

// Drive every Mirage tool through the Claude Agent SDK.
//
// Gives a Sonnet agent a task that exercises all six tools the Mirage
// MCP server exposes (execute_command, read, write, edit, ls, grep)
// against a RAM-backed workspace, prints each tool call, and verifies
// the final file contents.
//
// Usage:
//   pnpm --filter @struktoai/mirage-examples exec \
//     tsx agents/claude-agent-sdk/all_tools.ts

import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MountMode, OpsRegistry, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildOptions } from '@struktoai/mirage-agents/claude-agent-sdk'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const PROMPT = `You are operating on a Mirage virtual filesystem via the mirage tools.
Use exactly one mirage tool per step and do them in order:
1. Use the ls tool on '/'.
2. Use the write tool to create '/notes.txt' with lines: alpha, beta, gamma.
3. Use the read tool on '/notes.txt'.
4. Use the edit tool on '/notes.txt' to replace 'beta' with 'BETA'.
5. Use the grep tool to search for 'a' in '/notes.txt'.
6. Use the execute_command tool to run: cat /notes.txt | sort | wc -l
Briefly report what each step returned.`

const EXPECTED = new Set(
  ['execute_command', 'read', 'write', 'edit', 'ls', 'grep'].map((n) => `mcp__mirage__${n}`),
)

const ram = new RAMVFS()
const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })

const options = buildOptions(ws)
options.model = 'claude-sonnet-4-6'
options.permissionMode = 'bypassPermissions'
options.allowDangerouslySkipPermissions = true

const used: string[] = []
for await (const msg of query({ prompt: PROMPT, options })) {
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        used.push(block.name)
        console.log(`  -> ${block.name}  ${JSON.stringify(block.input)}`)
      }
    }
  } else if (msg.type === 'result' && msg.subtype === 'success') {
    console.log('\n=== final report ===')
    console.log(msg.result)
  }
}

console.log('\n=== tools used ===')
console.log(used)
const missing = [...EXPECTED].filter((t) => !used.includes(t))
console.log(
  'all six tools exercised:',
  missing.length === 0,
  '| missing:',
  missing.length > 0 ? missing : 'none',
)

const final = await ws.vfs.readFileText('/notes.txt')
console.log('\n=== /notes.txt final content (from the Mirage workspace) ===')
console.log(final)
