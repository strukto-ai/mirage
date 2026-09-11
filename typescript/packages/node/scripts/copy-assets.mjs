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

// `tsc` emits the .ts modules and nothing else, so every asset a module
// reads beside itself (`new URL('./cas.lua', import.meta.url)`) has to be
// copied to the same relative place under dist. tsup did this with an
// onSuccess hook into the dist root, which only worked because tsup put
// every module there too; a per-module dist mirrors the tree instead.
import { cpSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src')
const dist = resolve(here, '..', 'dist')

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walk(path)
    } else if (!name.endsWith('.ts')) {
      cpSync(path, join(dist, relative(src, path)))
    }
  }
}

walk(src)
