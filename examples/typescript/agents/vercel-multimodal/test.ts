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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { openai } from '@ai-sdk/openai'
import { generateText, stepCountIs } from 'ai'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = resolve(__HERE, '../../../..')

const PNG_PATH = resolve(REPO, 'docs/images/demo-linear-issue.png')
const PDF_PATH = resolve(REPO, 'paper/paper.pdf')

const MODEL = process.env.MIRAGE_TEST_MODEL ?? 'gpt-5.4'

async function main(): Promise<void> {
  if (process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY === '') {
    throw new Error('OPENAI_API_KEY is required')
  }

  const ram = new RAMVFS()
  const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE })
  await ws.vfs.writeFile('/chart.png', new Uint8Array(readFileSync(PNG_PATH)))
  await ws.vfs.writeFile('/paper.pdf', new Uint8Array(readFileSync(PDF_PATH)))

  console.log(`=== Vercel multimodal test (model=${MODEL}) ===\n`)
  console.log(`Files in workspace:`)
  console.log(`  /chart.png  ${String(readFileSync(PNG_PATH).length)} bytes`)
  console.log(`  /paper.pdf  ${String(readFileSync(PDF_PATH).length)} bytes\n`)

  const tools = mirageTools(ws)

  for (const target of ['/chart.png', '/paper.pdf']) {
    console.log(`--- prompting model to read ${target} ---`)
    const r = await generateText({
      model: openai(MODEL),
      tools,
      stopWhen: stepCountIs(4),
      system:
        'You are a vision-capable assistant with access to a Mirage workspace. Use the readFile tool when you need file contents. After reading, describe what you saw in 2 short sentences.',
      prompt: `Use the readFile tool to read ${target}, then describe what's in it.`,
    })
    console.log('reply:', r.text || '(empty)')
    console.log(
      'tool calls:',
      r.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
    )
    console.log('finish:', r.finishReason)
    console.log('usage:', JSON.stringify(r.usage), '\n')
  }

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
