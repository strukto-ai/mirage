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

import {
  GmailResource,
  MountMode,
  S3Resource,
  SlackResource,
  Workspace,
} from '@struktoai/mirage-node'
import { RAMResource } from '@struktoai/mirage-core'

async function main(): Promise<void> {
  const ws = new Workspace(
    {
      '/ram': new RAMResource(),
      '/s3': new S3Resource({ bucket: 'demo', region: 'us-east-1' }),
      '/slack': new SlackResource({ token: 'xoxb-demo' }),
      '/gmail': new GmailResource({ clientId: 'demo', clientSecret: 'demo', refreshToken: 'demo' }),
    },
    { mode: MountMode.WRITE },
  )

  const show = async (label: string, cmd: string): Promise<void> => {
    const r = await ws.execute(cmd)
    console.log(`\n========== ${label} (exit ${r.exitCode}) ==========`)
    if (r.stdoutText !== '') console.log(r.stdoutText)
    if (r.stderrText !== '') console.log(`[stderr] ${r.stderrText}`)
  }

  await show('man cat', 'man cat')
  await show('man find', 'man find')
  await show('man grep', 'man grep')
  await show('man gws gmail +send (gmail-only)', 'man "gws gmail +send"')
  await show('man date (general only)', 'man date')

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
