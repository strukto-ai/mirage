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

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  // Lua scripts are read at runtime relative to the emitted bundle, so
  // they must sit beside it in dist just as they sit beside their
  // module in src.
  onSuccess: 'cp src/workspace/session/cas.lua dist/cas.lua',
})
