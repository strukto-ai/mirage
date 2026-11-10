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

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node 24's V8 tiers a wasm-to-JS import wrapper up after 1000 calls and
    // frees the old one from a process-wide cache. When a terminated worker
    // thread (pyodide, one per python.test.ts case) released it, its JIT
    // page is already gone and the worker aborts on
    // `Check failed: jit_page.has_value()` on Linux. A budget no test reaches
    // never tiers up. It is a V8 flag, so NODE_OPTIONS refuses it; execArgv
    // sets it for the whole fork, worker threads included.
    execArgv: ['--wasm-wrapper-tiering-budget=1000000000'],
    // vitest's default leaves one CPU to its main process, which only
    // transforms and reports, so on a 4-core runner a quarter of this, the
    // longest test leg, sat idle.
    maxWorkers: '100%',
  },
})
