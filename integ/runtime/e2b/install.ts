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
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Pass the isolated consumer directory')
const require = createRequire(join(root, 'package.json'))
for (const name of ['core', 'browser']) {
  const manifest = require.resolve(`@struktoai/mirage-${name}/package.json`)
  assert.throws(() => createRequire(manifest).resolve('e2b'), { code: 'MODULE_NOT_FOUND' })
}

const core = JSON.parse(
  await readFile(require.resolve('@struktoai/mirage-core/package.json'), 'utf8'),
) as { peerDependencies: Record<string, string> }
const external = Object.keys(core.peerDependencies).filter((name) => name !== 'e2b')
const entry = join(root, 'browser-check.mjs')
try {
  await writeFile(entry, "export { Workspace } from '@struktoai/mirage-browser'\n")
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    worker: { format: 'es', rollupOptions: { external } },
    plugins: [
      {
        name: 'no-implicit-e2b',
        enforce: 'pre',
        resolveId(source) {
          // Vite can replace missing optional peers with a deferred error stub.
          assert.notEqual(source, 'e2b', 'The browser barrel must not resolve E2B')
        },
      },
    ],
    build: {
      write: false,
      target: 'esnext',
      lib: { entry, formats: ['es'] },
      // Other optional runtimes are outside this E2B packaging check.
      rollupOptions: { external },
    },
  })
  console.log('OK: browser package bundles without E2B installed')
} finally {
  await rm(entry, { force: true })
}
