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

import type { OpenMode } from '../handles/mode.ts'
import type { VFSStat } from '../types.ts'
import type { GuestCall, GuestReply, GuestRun } from './execution.ts'
import { GuestExit, type GuestFile, type GuestView, WasiFs, wasiImports } from './fs.ts'
import { failureText, requestOverBridge, requestSync } from './transport.ts'

// The worker a wasm guest runs on: the module runs here, blocking this
// thread on each host call as a process blocks on a syscall, while the
// host answers on its own loop. Python runs the guest the same way, on a
// worker thread whose calls wait on the event loop.
const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
const port = node === undefined ? null : (await import('node:worker_threads')).parentPort
const page = globalThis as unknown as {
  postMessage(m: unknown): void
  onmessage: ((e: MessageEvent<GuestRun>) => void) | null
}
const post = (message: GuestReply | (GuestCall & { kind: 'vfs' })): void => {
  if (port !== null) port.postMessage(message)
  else page.postMessage(message)
}
let bridge: string | undefined
// The bridge answers a null as nothing at all, and the calls here read a
// null as "none", so it is put back.
const call = (request: GuestCall): unknown =>
  (bridge === undefined ? requestSync(post, request) : requestOverBridge(post, request, bridge)) ??
  null

/** One open file of the host's, its calls made across the bridge. */
function guestFile(id: number, mode: OpenMode, opened: string, inode: string): GuestFile {
  const on = (method: string, ...args: unknown[]): unknown =>
    call({ op: 'file', file: id, method, args })
  return {
    mode,
    opened,
    inode,
    path: () => on('path') as string,
    position: () => on('position') as number,
    size: () => on('size') as number,
    read: (size) => on('read', size) as Uint8Array,
    pread: (offset, size) => on('pread', offset, size) as Uint8Array,
    write: (data) => on('write', data),
    pwrite: (offset, data) => on('pwrite', offset, data),
    seek: (offset, whence) => on('seek', offset, whence) as number | null,
    truncate: (size) => on('truncate', size),
    land: () => on('land'),
    close: () => on('close'),
    fstat: () => on('fstat') as VFSStat,
    unlinked: () => on('unlinked') as boolean,
  }
}

const viewCall = (method: string, ...args: unknown[]): unknown => call({ op: 'view', method, args })
const view: GuestView = {
  stat: (path) => viewCall('stat', path) as VFSStat,
  lstat: (path) => viewCall('lstat', path) as VFSStat,
  statOrNull: (path, nofollow = false) => viewCall('statOrNull', path, nofollow) as VFSStat | null,
  open: (path, mode) => {
    const { id, opened, inode } = viewCall('open', path, mode) as {
      id: number
      opened: string
      inode: string
    }
    return guestFile(id, mode, opened, inode)
  },
  unlink: (path) => viewCall('unlink', path),
  mkdir: (path) => viewCall('mkdir', path),
  rmdir: (path) => viewCall('rmdir', path),
  rename: (src, dst) => viewCall('rename', src, dst),
  symlink: (path, target) => viewCall('symlink', path, target),
  walked: (path, follow = true) => viewCall('walked', path, follow) as string,
  readlink: (path) => viewCall('readlink', path) as string,
  setattr: (path, atime, mtime, nofollow) => viewCall('setattr', path, atime, mtime, nofollow),
  readdir: (path) => viewCall('readdir', path) as [string, number][],
}

async function run(request: GuestRun): Promise<void> {
  bridge = request.bridge
  const wasi = new WasiFs(
    view,
    request.piped ? (size) => call({ op: 'stdin', args: [size] }) as Uint8Array : null,
    (fd, bytes) => call({ op: 'output', args: [fd, bytes] }) as boolean,
    (ms) => call({ op: 'sleep', args: [ms] }) as boolean,
    request.argv,
    request.env,
  )
  try {
    const instance = await WebAssembly.instantiate(request.module, wasiImports(wasi))
    wasi.memory = instance.exports.memory as WebAssembly.Memory
    let exitCode = 0
    let trap: string | null = null
    try {
      ;(instance.exports._start as () => void)()
    } catch (err) {
      if (err instanceof GuestExit) exitCode = err.code
      else {
        exitCode = 1
        trap = `wasm trap: ${failureText(err)}`
      }
    }
    post({ kind: 'result', exitCode, trap, lost: wasi.closeAll() })
  } catch (err) {
    post({ kind: 'error', message: failureText(err) })
  }
}

if (port !== null)
  port.on('message', (request: GuestRun) => {
    void run(request)
  })
else
  page.onmessage = (event) => {
    void run(event.data)
  }
post({ kind: 'ready' })
