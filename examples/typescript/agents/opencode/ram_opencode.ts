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
import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk'

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

try {
  const session = await client.session.create({ body: { title: 'mirage-cat-demo' } })
  const sessionId = (session.data as { id: string }).id

  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      parts: [
        {
          type: 'text',
          text: 'Run `cat /hello.txt` with the bash tool and report exactly what it printed.',
        },
      ],
    },
  })

  const data = result.data as { parts?: Array<{ type: string; text?: string }> }
  for (const part of data.parts ?? []) {
    if (part.type === 'text' && part.text !== undefined && part.text.length > 0) {
      console.log(part.text)
    }
  }
} finally {
  server.close()
}
