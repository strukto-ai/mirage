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

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const target = process.argv[2]
assert.ok(target, 'pass the fresh consumer directory')
const consumer = resolve(target)
const quickstart = readFileSync(
  new URL('../../docs/typescript/quickstart.mdx', import.meta.url),
  'utf8',
)
const install = readFileSync(new URL('../../docs/typescript/install.mdx', import.meta.url), 'utf8')
const setup = quickstart.match(/```bash\n(npm pkg set type=module)\n```/)?.[1]
assert.ok(setup, 'quickstart must include the ESM setup command')
assert.ok(install.includes(setup), 'installation must include the same ESM setup')
const example = quickstart.match(/```ts quickstart\.ts\n([\s\S]*?)\n```/)?.[1]
assert.ok(example, 'quickstart.ts example must exist')
const manifest: unknown = JSON.parse(readFileSync(resolve(consumer, 'package.json'), 'utf8'))
assert.ok(manifest !== null && typeof manifest === 'object')
assert.notEqual(
  'type' in manifest ? manifest.type : undefined,
  'module',
  'smoke must start with a fresh npm consumer',
)
execFileSync('npm', setup.split(' ').slice(1), { cwd: consumer, stdio: 'pipe' })
writeFileSync(resolve(consumer, 'quickstart.ts'), example)
const output = execFileSync('npx', ['--no-install', 'tsx', 'quickstart.ts'], {
  cwd: consumer,
  encoding: 'utf8',
  timeout: 60_000,
})
assert.equal(output, 'user.json\nalice\n{"name": "alice"}\n')
console.log('OK: documented TypeScript quickstart passed in a fresh npm consumer')
