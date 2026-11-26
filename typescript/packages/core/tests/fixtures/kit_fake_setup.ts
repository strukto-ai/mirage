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

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    kitFakeDir: string
  }
}

/**
 * The directory the run's kit fakes are found through, and their end. A run
 * that asks for no fake starts none: `serve` (kit_fake.ts) starts one the
 * first time a test file asks, and every other file reads its origin here.
 */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'kit-fake-'))
  project.provide('kitFakeDir', dir)
  return () => {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.pid')) continue
      try {
        process.kill(Number(readFileSync(join(dir, name), 'utf8')))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
