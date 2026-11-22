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

import { expect, it } from 'vitest'
import { processor } from './engine.ts'

it('uses the room available for each file processed by the same command', async () => {
  const ceiling = 32 * 1024 ** 2
  const process = processor(ceiling)
  const options = {
    verb: 'run',
    language: 'TypeScript',
    path: 'input.ts',
    pattern: 'return $X',
    view: 'auto',
    pub_members: false,
    directory: false,
    files_only: true,
    update: false,
  }
  const line = 'export function f(x:number){return x+1}\n'
  const encoder = new TextEncoder()
  const dense = encoder.encode(line.repeat(6000))
  expect((await process(options, encoder.encode(line), ceiling / 2)).count).toBe(1)
  expect((await process(options, dense, ceiling * 2)).count).toBe(1)
  await expect(process(options, dense, ceiling / 2)).rejects.toThrow(
    'parser resource limit exceeded',
  )
})

// Pinned against ast-grep 0.51.3, which bundles the Rust grammar and its
// default outline rules.
it('outlines a Rust file', async () => {
  const ceiling = 32 * 1024 ** 2
  const process = processor(ceiling)
  const options = {
    verb: 'outline',
    language: 'Rust',
    path: 's.rs',
    view: 'auto',
    pub_members: false,
    directory: false,
    files_only: false,
    update: false,
  }
  const source = new TextEncoder().encode(
    'pub struct S {\n    pub a: u32,\n    b: u8,\n}\n\nimpl S {\n    fn hidden(&self) {}\n}\n\nfn f() {}\n',
  )
  expect((await process(options, source, ceiling)).output).toBe(
    's.rs\n 1: pub struct S\n      field: a, b\n 6: impl S\n      method: hidden\n10: fn f()\n',
  )
})
