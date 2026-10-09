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
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as Node from '@struktoai/mirage-node'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

const DOCS = new URL('../../docs/typescript/cli/', import.meta.url)
const START = '{/* BEGIN GENERATED CLI COMMANDS */}'
const END = '{/* END GENERATED CLI COMMANDS */}'

function commands(node: Node.CLISpec, parents: readonly string[] = []): string[] {
  const path = [...parents, node.name]
  return [
    ...(node.fn === null ? [] : [path.join(' ')]),
    ...node.subcommands.flatMap((child) => commands(child, path)),
  ]
}

const specs = Object.values(Node).filter((value) => value instanceof Node.CLISpec)
assert.ok(specs.length > 0, 'No bundled CLI specs were loaded')
const pages = readdirSync(DOCS)
  .filter((name) => name.endsWith('.mdx') && name !== 'index.mdx' && name !== 'custom.mdx')
  .map((name) => name.slice(0, -4))
assert.deepEqual(
  pages.sort(compareCodePoints),
  specs.map((spec) => spec.name).sort(compareCodePoints),
  'CLI inventory differs',
)

for (const spec of specs) {
  const path = new URL(`${spec.name}.mdx`, DOCS)
  const text = readFileSync(path, 'utf8')
  assert.equal(text.split(START).length, 2, `Missing or repeated marker: ${fileURLToPath(path)}`)
  assert.equal(text.split(END).length, 2, `Missing or repeated marker: ${fileURLToPath(path)}`)
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  assert.ok(end > start, `Reversed markers: ${spec.name}`)
  const rows = [...text.slice(start, end).matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1])
  assert.deepEqual(
    rows,
    commands(spec),
    `${spec.name}: docs differ from the TypeScript command tree`,
  )
}
console.log(`CLI docs checked against TypeScript: ${String(specs.length)} programs`)
