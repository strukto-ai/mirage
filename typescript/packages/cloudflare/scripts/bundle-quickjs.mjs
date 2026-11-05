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

// quickjs-ng's WASI build, the release CI's QuickJS runs (QUICKJS_BUILD in
// the workflows), checked against its digest: the copy already here, the
// one under MIRAGE_QUICKJS_HOME, or the release's own.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 'v0.16.2'
const DIGEST = 'd2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc'
const RELEASE = `https://github.com/quickjs-ng/quickjs/releases/download/${VERSION}/qjs-wasi.wasm`

const output = new URL('../src/generated/', import.meta.url)
const target = new URL('qjs-wasi.wasm', output)
const sound = (bytes) => createHash('sha256').update(bytes).digest('hex') === DIGEST

mkdirSync(output, { recursive: true })
const home = process.env.MIRAGE_QUICKJS_HOME
const local = [target, ...(home ? [join(home, 'qjs-wasi.wasm')] : [])].find(
  (path) => existsSync(path) && sound(readFileSync(path)),
)
if (local === undefined) {
  const response = await fetch(RELEASE)
  if (!response.ok) throw new Error(`${RELEASE}: ${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!sound(bytes)) throw new Error(`${RELEASE} is not quickjs-ng ${VERSION}'s qjs-wasi.wasm`)
  writeFileSync(target, bytes)
} else if (local !== target) writeFileSync(target, readFileSync(local))
