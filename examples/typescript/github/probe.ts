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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { GitHubResource, MountMode, Workspace } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../.env.development') })
dotenv.config({ path: '/Users/zecheng/strukto/mirage/.env.development' })

async function main(): Promise<void> {
  const resource = await GitHubResource.create({
    token: process.env.GITHUB_TOKEN!,
    owner: 'strukto-ai',
    repo: 'mirage',
    ref: 'main',
  })
  const ws = new Workspace({ '/github': resource }, { mode: MountMode.READ })

  console.log('--- ls /github/python/mirage/resource ---')
  let r = await ws.execute('ls /github/python/mirage/resource')
  console.log(r.stdoutText)
  console.log('--- stat /github/python/mirage/resource/base.py ---')
  r = await ws.execute('stat /github/python/mirage/resource/base.py')
  console.log('STDOUT:', r.stdoutText)
  console.log('STDERR:', r.stderrText)
  console.log('EXIT:', r.exitCode)
  console.log('--- cat /github/python/mirage/resource/base.py | head -n 5 ---')
  r = await ws.execute('cat /github/python/mirage/resource/base.py | head -n 5')
  console.log('STDOUT:', r.stdoutText.slice(0, 300))
  console.log('STDERR:', r.stderrText)
  console.log('EXIT:', r.exitCode)
  await ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
