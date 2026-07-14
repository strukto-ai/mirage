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

import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

// (name, session, command, show) where show selects what the truth file
// records: "out" prints stdout, "err" prints stderr (byte-identical in
// both languages), "exit" prints only whether the command failed (for
// messages that legitimately differ between implementations).
type Case = [name: string, session: string, cmd: string, show: 'out' | 'err' | 'exit']

const CASES: Case[] = [
  ['seed_data', 'default', 'echo hello > /data/a.txt', 'exit'],
  ['seed_side', 'default', 'echo aside > /side/s.txt', 'exit'],
  // ----- read mode: reads pass, writes refuse like a READ mount -----
  ['reader_cat', 'reader', 'cat /data/a.txt', 'out'],
  ['reader_rm_denied', 'reader', 'rm /data/a.txt', 'err'],
  ['reader_redirect_denied', 'reader', 'echo leak > /data/new.txt', 'exit'],
  ['reader_no_partial_write', 'reader', 'ls /data', 'out'],
  // ----- unlisted mount: invisible -----
  ['reader_side_denied', 'reader', 'cat /side/s.txt', 'err'],
  // ----- write mode and list-form inherit -----
  ['writer_write', 'writer', 'echo w > /data/w.txt && cat /data/w.txt', 'out'],
  ['lister_inherits_write', 'lister', 'echo l > /data/l.txt && cat /data/l.txt', 'out'],
  // ----- a session mode cannot widen a READ mount -----
  ['widen_attempt_denied', 'capped', 'echo up > /ro/y.txt', 'exit'],
  // ----- restricted sessions keep pure text pipelines -----
  ['reader_pathless_wc', 'reader', 'echo hi | wc -l', 'out'],
]

const ROOT_CASES: Case[] = [
  ['root_seed', 'default', 'echo top > /root.txt', 'exit'],
  ['root_unlisted_denied', 'no_root', 'cat /root.txt', 'err'],
  ['root_read_mode', 'root_ro', 'cat /root.txt', 'out'],
  ['root_write_denied', 'root_ro', 'echo x > /root.txt', 'exit'],
]

async function run(ws: Workspace, label: string, cases: Case[]): Promise<void> {
  for (const [name, session, cmd, show] of cases) {
    const result = await ws.execute(cmd, { sessionId: session })
    process.stdout.write(`=== ${label}:${name} ===\n`)
    if (show === 'out') {
      const out = result.stdoutText
      process.stdout.write(out.endsWith('\n') || out === '' ? out : out + '\n')
    } else if (show === 'err') {
      const err = result.stderrText
      process.stdout.write(err.endsWith('\n') || err === '' ? err : err + '\n')
    }
    process.stdout.write(`failed=${result.exitCode !== 0 ? 'True' : 'False'}\n`)
  }
}

async function main(): Promise<void> {
  const ws = new Workspace(
    {
      '/data': new RAMResource(),
      '/side': new RAMResource(),
      '/ro': [new RAMResource(), MountMode.READ] as const,
    },
    { mode: MountMode.WRITE },
  )
  try {
    ws.createSession('reader', { mounts: { '/data': MountMode.READ } })
    ws.createSession('writer', { mounts: { '/data': MountMode.WRITE } })
    ws.createSession('lister', { mounts: ['/data'] })
    ws.createSession('capped', { mounts: { '/ro': MountMode.WRITE } })
    await run(ws, 'modes', CASES)
  } finally {
    await ws.close()
  }

  const wsRoot = new Workspace(
    { '/': new RAMResource(), '/data': new RAMResource() },
    { mode: MountMode.WRITE },
  )
  try {
    wsRoot.createSession('no_root', { mounts: { '/data': MountMode.WRITE } })
    wsRoot.createSession('root_ro', { mounts: { '/data': MountMode.WRITE, '/': MountMode.READ } })
    await run(wsRoot, 'root', ROOT_CASES)
  } finally {
    await wsRoot.close()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
