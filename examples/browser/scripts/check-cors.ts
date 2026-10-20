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
import { GetBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'
import dotenv from 'dotenv'

const here = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(here, '../../../.env.development') })

async function main(): Promise<void> {
  const c = new S3Client({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
  const r = await c.send(new GetBucketCorsCommand({ Bucket: process.env.AWS_S3_BUCKET! }))
  console.log(JSON.stringify(r.CORSRules, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
