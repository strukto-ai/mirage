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

// The deployed TypeScript server: buildApp() listening, every setting
// from the environment as in a deployment, and the snapshot store an
// operator passes buildApp from ACCESS_SNAPSHOT_STORE (an S3Config as
// JSON). Run from integ/ as `node --import tsx access/serve.ts PORT`;
// `--routes` prints the route table as JSON instead.
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { buildApp } from '../../typescript/packages/server/src/app.ts'

const store = process.env.ACCESS_SNAPSHOT_STORE
const app = buildApp(
  store !== undefined && store !== '' ? { snapshotStore: JSON.parse(store) as S3Config } : {},
)
if (process.argv[2] === '--routes') {
  const routes: string[] = []
  await app.ready()
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) routes.push(line)
  console.log(JSON.stringify(routes))
  await app.close()
} else {
  await app.listen({ host: '127.0.0.1', port: Number(process.argv[2]) })
}
