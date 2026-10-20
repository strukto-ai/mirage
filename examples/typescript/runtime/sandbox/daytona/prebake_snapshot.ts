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

// Build the "mirage-fuse" Daytona snapshot once. Sandbox creation from
// a snapshot takes seconds; building this image inline would sit in
// the first captured line's path for many minutes. Run again after a
// mirage release to refresh the baked package.

import { Daytona, Image } from '@daytona/sdk'
import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../../.env.development') })

const SNAPSHOT_NAME = 'mirage-fuse'

const MIRAGE_GIT_SPEC =
  'mirage-ai[s3,fuse] @ git+https://github.com/strukto-ai/mirage.git#subdirectory=python'

async function main(): Promise<void> {
  const daytona = new Daytona()
  const image = Image.debianSlim('3.12')
    .runCommands(
      'apt-get update ' +
        '&& apt-get install -y --no-install-recommends ' +
        '    git fuse3 libfuse3-dev ' +
        "&& sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf " +
        '&& rm -rf /var/lib/apt/lists/*',
    )
    .pipInstall(MIRAGE_GIT_SPEC)
  try {
    const snapshot = await daytona.snapshot.create(
      {
        name: SNAPSHOT_NAME,
        image,
        resources: { cpu: 1, memory: 1, disk: 3 },
      },
      {
        onLogs: (line: string) => console.log(`  build: ${line}`),
        timeout: 0,
      },
    )
    console.log(`snapshot ready: ${snapshot.name}`)
  } finally {
    await daytona[Symbol.asyncDispose]()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
