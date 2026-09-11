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

import { expect, test } from 'vitest'

import { DISK_OPS } from './disk/index.ts'
import { EMAIL_OPS } from './email/index.ts'
import { HF_OPS } from './hf/index.ts'
import { SSH_OPS } from './ssh/index.ts'

// Golden snapshot of every backend's registered op surface, taken before
// the ops-layer refactor. Each row is [name, resource, filetype, write];
// filetype '' means no filetype binding. Any diff here is a registration
// regression unless the change is deliberate.

type Row = [string, string, string, boolean]

const TABLES = {
  disk: DISK_OPS,
  email: EMAIL_OPS,
  hf: HF_OPS,
  ssh: SSH_OPS,
}

const OPS_INVENTORY: Record<string, Row[]> = {
  disk: [
    ['append', 'disk', '', true],
    ['create', 'disk', '', true],
    ['mkdir', 'disk', '', true],
    ['read', 'disk', '', false],
    ['readdir', 'disk', '', false],
    ['rename', 'disk', '', true],
    ['rmdir', 'disk', '', true],
    ['setattr', 'disk', '', true],
    ['stat', 'disk', '', false],
    ['truncate', 'disk', '', true],
    ['unlink', 'disk', '', true],
    ['write', 'disk', '', true],
  ],
  email: [
    ['read', 'email', '', false],
    ['readdir', 'email', '', false],
    ['stat', 'email', '', false],
  ],
  hf: [
    ['create', 'hf_buckets', '', true],
    ['create', 'hf_datasets', '', true],
    ['create', 'hf_models', '', true],
    ['create', 'hf_spaces', '', true],
    ['mkdir', 'hf_buckets', '', true],
    ['mkdir', 'hf_datasets', '', true],
    ['mkdir', 'hf_models', '', true],
    ['mkdir', 'hf_spaces', '', true],
    ['read', 'hf_buckets', '', false],
    ['read', 'hf_datasets', '', false],
    ['read', 'hf_models', '', false],
    ['read', 'hf_spaces', '', false],
    ['readdir', 'hf_buckets', '', false],
    ['readdir', 'hf_datasets', '', false],
    ['readdir', 'hf_models', '', false],
    ['readdir', 'hf_spaces', '', false],
    ['stat', 'hf_buckets', '', false],
    ['stat', 'hf_datasets', '', false],
    ['stat', 'hf_models', '', false],
    ['stat', 'hf_spaces', '', false],
    ['unlink', 'hf_buckets', '', true],
    ['unlink', 'hf_datasets', '', true],
    ['unlink', 'hf_models', '', true],
    ['unlink', 'hf_spaces', '', true],
    ['write', 'hf_buckets', '', true],
    ['write', 'hf_datasets', '', true],
    ['write', 'hf_models', '', true],
    ['write', 'hf_spaces', '', true],
  ],
  ssh: [
    ['append', 'ssh', '', true],
    ['create', 'ssh', '', true],
    ['mkdir', 'ssh', '', true],
    ['read', 'ssh', '', false],
    ['readdir', 'ssh', '', false],
    ['rename', 'ssh', '', true],
    ['rmdir', 'ssh', '', true],
    ['setattr', 'ssh', '', true],
    ['stat', 'ssh', '', false],
    ['truncate', 'ssh', '', true],
    ['unlink', 'ssh', '', true],
    ['write', 'ssh', '', true],
  ],
}

const sortRows = (rows: Row[]): Row[] =>
  [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))

for (const [backend, ops] of Object.entries(TABLES)) {
  test(`ops inventory: ${backend}`, () => {
    const actual = sortRows(ops.map((o) => [o.name, o.resource, o.filetype ?? '', o.write] as Row))
    const expected = OPS_INVENTORY[backend]
    if (!expected) throw new Error(`missing fixture: ${backend}`)
    expect(actual).toEqual(sortRows(expected))
  })
}
