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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Workspace,
  configToWorkspaceArgs,
  loadWorkspaceConfigFile,
} from '@struktoai/mirage-node'

import { start } from './exec_server.ts'

// workspace.yaml loads RemoteRuntime from remote_runtime.mjs beside it and
// points it at an execution service; exec_server.ts stands in for the
// service on this machine. The agent only types commands: the yaml decides
// that python3 runs on the service and cat runs in the workspace.

const CONFIG = fileURLToPath(new URL('./workspace.yaml', import.meta.url))

const REPORT = `import csv
rows = list(csv.DictReader(open("orders.csv")))
total = sum(int(r["total"]) for r in rows)
open("summary.txt", "w").write(f"{len(rows)} orders, total {total}\\n")
print(f"wrote summary.txt on the service: total {total}")
`

const ORDERS = 'id,item,total\n1,desk,120\n2,chair,80\n3,shelf,45\n'

const LINES: [string, string][] = [
  ['cd /work && python3 report.py', 'runs on the service'],
  ['cat /work/summary.txt', 'its output file is back in the mount'],
  [
    "cd /work && python3 report.py | grep -o 'total [0-9]*'",
    'its stdout pipes into workspace commands',
  ],
  ["echo 'print(6 * 7)' | python3 -", 'stdin reaches the program'],
  ['cd /archive && python3 report.py', 'a read-only mount refuses it'],
  ['ls /archive', 'and nothing was written'],
  [
    "timeout 1 python3 -c 'import time; time.sleep(30)'",
    'a timeout stops the program on the service',
  ],
]

const dec = new TextDecoder()

async function main(): Promise<void> {
  const { server, url } = await start()
  const archive = mkdtempSync(join(tmpdir(), 'archive-'))
  try {
    writeFileSync(join(archive, 'report.py'), REPORT)
    writeFileSync(join(archive, 'orders.csv'), ORDERS)
    process.env.ARCHIVE_DIR = archive
    process.env.EXEC_URL = url
    const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(CONFIG))
    const ws = new Workspace(args.mounts, args.options)
    try {
      await ws.vfs.write('/work/report.py', REPORT)
      await ws.vfs.write('/work/orders.csv', ORDERS)
      for (const [line, note] of LINES) {
        const res = await ws.shell(line)
        console.log(`$ ${line}    # ${note}`)
        process.stdout.write(res.stdout === null ? '' : dec.decode(res.stdout))
        process.stdout.write(res.stderr === null ? '' : dec.decode(res.stderr))
        console.log(`[exit ${res.exitCode}]\n`)
      }
    } finally {
      await ws.close()
    }
  } finally {
    server.close()
    rmSync(archive, { recursive: true, force: true })
  }
}

await main()
