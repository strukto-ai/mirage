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

// Only the pool is set here; everything else stays on vitest's defaults, so
// this changes scheduling and nothing else. This package spends far more time
// loading modules than running tests, and a worker thread starts much cheaper
// than a forked process. Nothing in it writes a process global, which is what
// keeps server on forks: its setup file rewrites process.env.HOME per worker.
export default defineConfig({
  test: {
    pool: 'threads',
  },
})
