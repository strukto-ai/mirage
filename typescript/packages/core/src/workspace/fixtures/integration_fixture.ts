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

import { materialize } from '../../io/types.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace.ts'
import { getTestParser } from './workspace_fixture.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export interface IntegrationWS {
  ws: Workspace
  data: RAMResource
}

function put(res: RAMResource, path: string, data: string | Uint8Array): void {
  res.store.files.set(path, typeof data === 'string' ? ENC.encode(data) : data)
}

/**
 * Mirrors the `FILES` + `ws` fixture in tests/integration/test_shell_patterns.py.
 * All test data lives under /data/... in a single RAMResource.
 */
export async function makeIntegrationWS(
  files: Record<string, string | Uint8Array> = {},
): Promise<IntegrationWS> {
  const parser = await getTestParser()
  const data = new RAMResource()
  for (const [relPath, body] of Object.entries(files)) {
    put(data, `/${relPath}`, body)
  }
  const registry = new OpsRegistry()
  registry.registerResource(data)
  const ws = new Workspace(
    { '/data': data },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  return { ws, data }
}

export async function run(ws: Workspace, cmd: string): Promise<string> {
  const io = await ws.execute(cmd)
  return DEC.decode(io.stdout)
}

export async function runExit(ws: Workspace, cmd: string): Promise<number> {
  const io = await ws.execute(cmd)
  return io.exitCode
}

export async function runResult(ws: Workspace, cmd: string): Promise<[number, string, string]> {
  const io = await ws.execute(cmd)
  return [io.exitCode, DEC.decode(io.stdout), DEC.decode(await materialize(io.stderr))]
}

export const INTEGRATION_FILES: Record<string, string> = {
  'logs/app.log':
    '2026-01-01 INFO startup\n' +
    '2026-01-02 ERROR connection refused\n' +
    '2026-01-03 INFO request handled\n' +
    '2026-01-04 WARN slow query\n' +
    '2026-01-05 ERROR timeout\n' +
    '2026-01-06 INFO shutdown\n',
  'logs/access.log':
    'GET /api/users 200\n' +
    'POST /api/users 201\n' +
    'GET /api/users 200\n' +
    'DELETE /api/users/1 404\n' +
    'GET /api/health 200\n',
  'data/scores.csv': 'alice,90\nbob,75\ncharlie,90\nalice,85\nbob,95\n',
  'data/words.txt': 'hello\nworld\nhello\nfoo\nbar\nfoo\nhello\n',
  'data/numbers.txt': '3\n1\n4\n1\n5\n9\n2\n6\n5\n3\n',
  'src/main.py': "import os\nimport sys\nprint('hello')\n",
  'src/utils.py': 'def add(a, b):\n    return a + b\n',
  'config.json': '{"name": "mirage", "version": "1.0"}\n',
  'empty.txt': '',
}
