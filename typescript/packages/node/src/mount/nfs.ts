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

import { execFile } from 'node:child_process'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { constants as osConstants } from 'node:os'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { NFSEngine, type NFSRequest } from '@struktoai/mirage-core/rs/nfs'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { LISTING_CONCURRENCY } from './constants.ts'
import type { MountCore } from './core.ts'
import { classifyErrno } from './errors.ts'
import type { MountAttrs } from './types.ts'

export const HOST = '127.0.0.1'
export const LINUX_OPTIONS =
  'vers=3,proto=tcp,mountproto=tcp,mountvers=3,nolock,soft,timeo=50,' +
  'retrans=2,ro,addr=127.0.0.1,mountaddr=127.0.0.1'
export const DARWIN_OPTIONS =
  'vers=3,tcp,nolocks,soft,intr,timeo=50,retrans=2,deadtimeout=60,rdonly,noresvport'
export const MOUNT_TIMEOUT = 30

/**
 * The system command that mounts the server on `port` at `mountpoint`:
 * read-only and soft, so an I/O against a server that went away fails rather
 * than hangs. Throws on a platform with no NFS client mirage drives.
 * Mirrors Python's mount_args.
 */
export function mountArgs(
  port: number,
  mountpoint: string,
  platform: string = process.platform,
): string[] {
  const ports = `port=${String(port)},mountport=${String(port)}`
  if (platform === 'darwin') {
    return ['/sbin/mount_nfs', '-o', `${DARWIN_OPTIONS},${ports}`, `${HOST}:/`, mountpoint]
  }
  if (platform.startsWith('linux')) {
    return ['mount', '-t', 'nfs', '-o', `${LINUX_OPTIONS},${ports}`, `${HOST}:/`, mountpoint]
  }
  throw new Error(
    `the nfs mount backend runs on Linux and macOS, not '${platform}'; use backend 'fuse'`,
  )
}

/**
 * The commands that unmount `mountpoint`, tried in order until one succeeds:
 * a plain unmount, then a forced or lazy one. Mirrors Python's unmount_args.
 */
export function unmountArgs(mountpoint: string, platform: string = process.platform): string[][] {
  if (platform === 'darwin') {
    return [
      ['umount', mountpoint],
      ['diskutil', 'unmount', 'force', mountpoint],
    ]
  }
  return [
    ['umount', mountpoint],
    ['umount', '-l', mountpoint],
  ]
}

/** Mount the server on `port` at `mountpoint`; throws when the system mount refuses. */
export async function mountNfs(port: number, mountpoint: string): Promise<void> {
  const [command = '', ...rest] = mountArgs(port, mountpoint)
  try {
    await promisify(execFile)(command, rest, { timeout: MOUNT_TIMEOUT * 1000 })
  } catch (err) {
    const failure = err as { stderr?: string; code?: number | string }
    let reason = failure.stderr?.trim() ?? ''
    if (reason === '') reason = `exit ${String(failure.code)}`
    if (process.platform === 'linux' && process.getuid?.() !== 0) {
      reason += "; mounting NFS needs root on Linux, or use backend 'fuse'"
    }
    throw new Error(`nfs mount at ${mountpoint} failed: ${reason}`)
  }
}

/** Unmount `mountpoint`, forcing it when a plain unmount is refused. */
export async function unmountNfs(mountpoint: string): Promise<void> {
  for (const [command = '', ...rest] of unmountArgs(mountpoint)) {
    try {
      await promisify(execFile)(command, rest, { timeout: MOUNT_TIMEOUT * 1000 })
      return
    } catch (err) {
      console.debug(`nfs: ${command} ${rest.join(' ')} failed: ${String(err)}`)
    }
  }
  console.warn(`nfs: ${mountpoint} is still mounted`)
}

/** A time as NFS carries it: `[seconds, nanoseconds]`; before the epoch reads as the epoch. */
export function wireTime(date: Date): [number, number] {
  const ms = Math.max(date.getTime(), 0)
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000]
}

/** One entry's attributes as the engine reads them. */
export function wireAttrs(attrs: MountAttrs): Record<string, JsonValue> {
  return {
    mode: attrs.mode,
    size: attrs.size,
    nlink: attrs.nlink,
    uid: attrs.uid,
    gid: attrs.gid,
    atime: wireTime(attrs.atime),
    mtime: wireTime(attrs.mtime),
    ctime: wireTime(attrs.ctime),
  }
}

/**
 * An NFSv3 server over a mount core, on a local TCP port. The protocol is
 * mirage-rs's (`NFSEngine`); this owns the sockets and runs each file
 * operation the engine asks for on the core, so a kernel NFS client mounts
 * the core's tree with no driver installed. Mirrors Python's MirageNFSServer.
 */
export class MirageNFSServer {
  private engine: NFSEngine | null = null
  private server: Server | null = null
  private readonly sockets = new Map<number, Socket>()
  private nextConn = 0

  constructor(
    private readonly core: MountCore,
    private readonly exportPath = '/',
  ) {}

  /** Listen on `host`, and return the port a client mounts. */
  async start(host = '127.0.0.1', port = 0): Promise<number> {
    const server = createServer((socket) => {
      this.serve(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        resolve()
      })
    })
    const bound = (server.address() as AddressInfo).port
    this.engine = await NFSEngine.open(this.exportPath, Date.now(), bound)
    this.server = server
    return bound
  }

  /** Stop listening and drop every connection. */
  async close(): Promise<void> {
    for (const socket of this.sockets.values()) socket.destroy()
    const server = this.server
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
    this.engine?.dispose()
    this.engine = null
  }

  private serve(socket: Socket): void {
    const engine = this.engine
    if (engine === null) {
      socket.destroy()
      return
    }
    const conn = ++this.nextConn
    this.sockets.set(conn, socket)
    socket.on('data', (data: Buffer) => {
      let out: Uint8Array
      try {
        out = engine.feed(conn, data)
      } catch (err) {
        console.debug(`nfs: connection ${String(conn)} refused: ${String(err)}`)
        socket.destroy()
        return
      }
      if (out.length > 0) socket.write(out)
      this.dispatch(engine)
    })
    socket.on('error', (err) => {
      console.debug(`nfs: connection ${String(conn)} dropped: ${String(err)}`)
    })
    socket.on('close', () => {
      this.sockets.delete(conn)
      engine.close(conn)
    })
  }

  private dispatch(engine: NFSEngine): void {
    for (const request of engine.requests()) void this.run(engine, request)
  }

  private async run(engine: NFSEngine, request: NFSRequest): Promise<void> {
    const [reply, data] = await this.answer(request)
    const [conn, out] = engine.complete(request.id, reply, data)
    const socket = conn === null ? undefined : this.sockets.get(conn)
    if (socket !== undefined && out.length > 0) socket.write(out)
    this.dispatch(engine)
  }

  private async answer(request: NFSRequest): Promise<[Record<string, JsonValue>, Uint8Array]> {
    try {
      switch (request.op) {
        case 'getattr':
          return [{ attrs: wireAttrs(await this.core.getattr(request.path)) }, new Uint8Array()]
        case 'readdir':
          return [{ entries: await this.listing(request.path) }, new Uint8Array()]
        case 'read':
          return [
            {},
            await this.core.read(request.path, -1, request.offset ?? 0, request.size ?? 0),
          ]
        case 'readlink':
          return [{ target: await this.core.readlink(request.path) }, new Uint8Array()]
      }
    } catch (err) {
      console.debug(`nfs: ${request.op} ${request.path}: ${String(err)}`)
      const code = classifyErrno(err)
      const name = Object.entries(osConstants.errno).find(([, errno]) => errno === code)?.[0]
      return [{ error: name ?? 'EIO' }, new Uint8Array()]
    }
  }

  private async listing(path: string): Promise<JsonValue[]> {
    const names = (await this.core.readdir(path)).filter((name) => name !== '.' && name !== '..')
    const rows: JsonValue[] = new Array<JsonValue>(names.length).fill(null)
    const todo = names.entries()
    const worker = async (): Promise<void> => {
      for (const [index, name] of todo) {
        try {
          const attrs = await this.core.getattr(posix.join(path, name))
          rows[index] = { name, attrs: wireAttrs(attrs) }
        } catch (err) {
          const code = classifyErrno(err)
          if (code !== osConstants.errno.ENOENT && code !== osConstants.errno.ENOTDIR) throw err
          console.debug(`nfs: ${name} vanished while listing: ${String(err)}`)
          rows[index] = { name, attrs: null }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, names.length) }, worker))
    return rows
  }
}
