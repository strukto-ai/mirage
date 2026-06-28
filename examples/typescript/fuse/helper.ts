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

// helper.ts — long-running child process that owns the FUSE mount.
//
// Its only job: mount /data/ as FUSE, print the mountpoint on stdout
// so the parent can read it, then sit idle servicing FUSE callbacks
// until killed. Since this process does not spawn subprocesses of its
// own, the single-event-loop deadlock (see /typescript/limitations)
// never triggers here.
import { FuseManager, MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data/': new RAMResource() },
    { mode: MountMode.WRITE },
  )

  // Seed a file so the parent has something to read.
  await ws.execute('echo "hello from helper" | tee /data/hello.txt')
  // Use printf (not echo) so the \n escapes expand to real newlines.
  await ws.execute(`printf 'line1\\nline2\\nline3\\n' | tee /data/multi.txt`)

  const fm = new FuseManager()
  const mp = await fm.setup(ws)

  // Emit the mountpoint as a single line the parent can readline on.
  // Flush immediately so the parent doesn't block.
  process.stdout.write(`${mp}\n`)

  // Handle shutdown so the parent can stop us cleanly via SIGTERM.
  const shutdown = async (): Promise<void> => {
    try {
      await fm.unmount()
    } finally {
      await ws.close()
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })

  // Keep the event loop alive servicing FUSE callbacks until signaled.
  // We intentionally do NOT read stdin here — that would cause the parent
  // to block writing to our stdin, and we don't need input from it.
  await new Promise(() => {
    /* never resolves */
  })
}

main().catch((err: unknown) => {
  console.error('[helper] fatal:', err)
  process.exit(1)
})
