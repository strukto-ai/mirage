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

// Mount a workspace over NFS, with no FUSE driver installed.
//
// Needs the @struktoai/mirage-nfs-node addon (or MIRAGE_NFS_ADDON pointed
// at a local `cargo build --release` of packages/mirage-nfs) and a kernel
// NFS client, which macOS and Linux both ship. Run it:
//
//     pnpm exec tsx examples/typescript/nfs/nfs.ts
//
// On macOS a loopback mount needs no privileges; Linux needs them, so run
// it under sudo there.
//
// Three rules the code below follows, and you must too:
//
//   * Every touch of the mountpoint goes through a child process. This
//     process's event loop is what answers the NFS request, so a
//     readFileSync on the mountpoint would block the loop that has to
//     serve it.
//   * One server backs every prefix, so the second mount costs a kernel
//     mount rather than a second server.
//   * close() is the whole teardown: it unmounts every export, flushes
//     what is still buffered, stops the server, and releases the event
//     loop, so the process exits on its own.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { Mount, MountBackend, MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

const run = promisify(execFile)

/** Run one command in a child process and capture its output. */
async function sh(command: string, args: string[]): Promise<string> {
  const { stdout } = await run(command, args, { timeout: 30_000 })
  return stdout.trim()
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new Mount(new RAMResource(), { backend: MountBackend.NFS }) },
    { mode: MountMode.WRITE },
  )
  try {
    await ws.execute("echo 'hello over nfs' > /data/hello.txt")
    await ws.execute('mkdir -p /data/docs && echo beta > /data/docs/b.txt')

    // The constructor cannot await, so the declared mount is awaited here;
    // `execute` above already did it, this is the explicit spelling.
    await ws.nfsReady()
    const mountpoint = ws.nfsMountpoints['/data'] ?? ''
    console.log(`=== NFS MODE: /data mounted at ${mountpoint} ===\n`)

    console.log(`ls ${mountpoint}\n${await sh('ls', ['-1', mountpoint])}\n`)
    console.log(`cat hello.txt -> ${JSON.stringify(await sh('cat', [`${mountpoint}/hello.txt`]))}`)

    // A write through the kernel is buffered per open handle: this server
    // never sees a COMMIT, so the bytes reach the resource on the idle
    // flush (NFSConfig.idleFlushSeconds, 5s by default) or at close.
    // Reads through the mount see them at once, because the adapter merges
    // the buffer; mirage's own command surface lags until the flush.
    await sh('sh', ['-c', `echo 'written by the kernel' > ${mountpoint}/kernel.txt`])
    console.log(
      `\ncat kernel.txt through the mount -> ${JSON.stringify(
        await sh('cat', [`${mountpoint}/kernel.txt`]),
      )}`,
    )
    const early = await ws.execute('cat /data/kernel.txt')
    console.log(`mirage before the flush     -> ${JSON.stringify(early.stdoutText.trim())}`)
    // The sweep runs every idleFlushSeconds and flushes handles that have
    // been idle that long, so the worst case is two windows.
    console.log('waiting ~12s for the idle flush...')
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    const late = await ws.execute('cat /data/kernel.txt')
    console.log(`mirage after the flush      -> ${JSON.stringify(late.stdoutText.trim())}`)

    // One server, a second export: /data/docs gets its own mountpoint.
    const docs = await ws.addNfsMount('/data/docs')
    console.log(`\nsecond mount (same server): ${docs}`)
    console.log(`cat b.txt -> ${JSON.stringify(await sh('cat', [`${docs}/b.txt`]))}`)
    console.log(`live mounts: ${JSON.stringify(ws.nfsMountpoints)}`)
  } finally {
    // Unmounts every export, flushes buffered writes, stops the server.
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
