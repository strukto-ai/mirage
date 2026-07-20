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

import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createOpencodeServer,
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../../.env.development') })

if (process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY === '') {
  console.error('OPENAI_API_KEY missing in .env.development')
  process.exit(1)
}

process.chdir(here)

const server = await createOpencodeServer({
  timeout: 30_000,
  config: {
    provider: {
      openai: {
        npm: '@ai-sdk/openai',
        name: 'OpenAI',
        models: { 'gpt-5.4-mini': { name: 'GPT-5.4 mini' } },
      },
    },
  },
})
const client = createOpencodeClient({ baseUrl: server.url })

const MODEL = { providerID: 'openai', modelID: 'gpt-5.4-mini' }
const PROMPT = 'Run `cat /hello.txt` with the bash tool and report exactly what it printed.'

async function runSession(c: OpencodeClient, title: string): Promise<void> {
  const session = await c.session.create({ body: { title } })
  const sessionId = (session.data as { id: string }).id
  const result = await c.session.prompt({
    path: { id: sessionId },
    body: { model: MODEL, parts: [{ type: 'text', text: PROMPT }] },
  })
  if (result.error !== undefined) {
    throw new Error(`[${title}] OpenCode prompt failed: ${JSON.stringify(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error(`[${title}] OpenCode prompt returned no data`)
  }
  if (result.data.info.error !== undefined) {
    throw new Error(
      `[${title}] OpenCode model failed: ${JSON.stringify(result.data.info.error)}`,
    )
  }
  const text = result.data.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  if (text.length === 0) {
    throw new Error(
      `[${title}] OpenCode returned no text; parts: ${result.data.parts.map((part) => part.type).join(', ')}`,
    )
  }
  console.log(`[${title}] ${text}`)
}

try {
  await Promise.all([runSession(client, 'alice'), runSession(client, 'bob')])
} finally {
  server.close()
}
