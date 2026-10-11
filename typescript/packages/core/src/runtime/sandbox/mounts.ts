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

import { getCurrentSession } from '../../context/session_context.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { singleQuote } from '../../utils/quote.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { Files } from '../../workspace/files.ts'
import type { SessionState } from '../../workspace/session/session.ts'
import type { WorkspaceBinding } from '../binding.ts'
import type { MountType, PipeWriter, RunResult, SandboxPipe } from '../types.ts'
import {
  MOUNT_POLL_SECONDS,
  MOUNT_WAIT_SECONDS,
  PIPE_SERVER_HINT,
  SSHFS_HINT,
  SSHFS_LOG_PREFIX,
  SSHFS_OPTIONS,
  UNMOUNT_WAIT_SECONDS,
} from './constants.ts'

/** How a served prefix's SFTP runs on its pipe (node's servePipe). */
export type PipeServer = (
  files: Files,
  session: SessionState,
  reader: ReadableStream<Uint8Array>,
  writer: PipeWriter,
) => Promise<void>

let pipeServer: PipeServer | null = null

/**
 * Where node puts the SFTP server a served prefix's pipe runs. Core has
 * none of its own: MountCore and ssh2 are node's.
 */
export function registerPipeServer(serve: PipeServer): void {
  pipeServer = serve
}

const DECODER = new TextDecoder()
const OCTAL_ESCAPE = /\\([0-7]{3})/g

function octalChar(_match: string, digits: string): string {
  return String.fromCharCode(parseInt(digits, 8))
}

/**
 * Each mountpoint a `/proc/mounts` lists, with its type. The kernel
 * escapes a space in a path as `\040`; that is undone. A point mounted
 * twice keeps the later (top) entry's type.
 */
export function mountTable(text: string): Map<string, string> {
  const table = new Map<string, string>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const [, point, kind] = fields
    if (point !== undefined && kind !== undefined) {
      table.set(point.replace(OCTAL_ESCAPE, octalChar), kind)
    }
  }
  return table
}

/**
 * The prefixes a sandbox mounts: each one under no other. A prefix under
 * another is served through it. The root and the workspace's devices are
 * left out: a sandbox's `/` and `/dev` are its own, and nothing can be
 * mounted over them.
 */
export function topPrefixes(prefixes: Iterable<string>): string[] {
  const paths = new Set<string>()
  for (const prefix of prefixes) paths.add(rstripSlash(prefix))
  paths.delete('')
  paths.delete('/dev')
  const tops: string[] = []
  for (const prefix of [...paths].sort(compareCodePoints)) {
    if (!tops.some((top) => prefix.startsWith(top + '/'))) tops.push(prefix)
  }
  return tops
}

function said(bytes: Uint8Array | null): string {
  return bytes === null ? '' : DECODER.decode(bytes).trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within(task: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`still running after ${String(ms)} ms`))
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Served {
  prefix: string
  pipe: SandboxPipe
  serving: Promise<void>
  done: boolean
}

/**
 * The workspace prefixes one sandbox sees, by its `mountType`.
 *
 * `ssh`: every prefix the session sees is served from the host over SFTP,
 * and the sandbox mounts each with `sshfs -o passive` on a pipe the
 * provider holds open, so every file op in the sandbox is an op of the
 * session, held to its hides, modes and policies. `fuse`: a mirage in the
 * sandbox serves its prefixes itself and the host serves none. `both`: a
 * prefix the sandbox already mounts is its own, and the host serves the
 * rest. A prefix the sandbox serves itself is out of the session's rules'
 * reach, so a line is refused while a hide or rule covers anything under
 * one.
 *
 * The mounts are made on the first line. What the host serves shows that
 * line's session: one path in a sandbox shows one view, so while the host
 * serves anything, a line of another session is refused rather than shown
 * the first one's.
 */
export class SandboxMounts {
  private mounted = false
  private sessionId: string | null = null
  private own: readonly string[] = []
  private served: Served[] = []
  private lock: Promise<unknown> = Promise.resolve()

  /**
   * @param runtime the runtime's name, for messages.
   * @param mountType ssh, fuse or both.
   * @param run runs one setup command in the sandbox.
   * @param openPipe starts a command in the sandbox with its stdin and
   *   stdout held open.
   */
  constructor(
    private readonly runtime: string,
    private readonly mountType: MountType,
    private readonly run: (line: string) => Promise<RunResult>,
    private readonly openPipe: (command: string) => Promise<SandboxPipe>,
  ) {}

  /** Mount on the first line; after that, why a line may not run, or null when it may. */
  async admit(binding: WorkspaceBinding | null): Promise<string | null> {
    const files = binding?.files ?? null
    if (binding === null || files === null) {
      throw new Error(`${this.runtime}: mountType needs the runtime in a workspace`)
    }
    const session = getCurrentSession()
    if (session === null) {
      throw new Error(
        `${this.runtime}: mountType serves a session's view, and this line runs as none`,
      )
    }
    const refusal = await this.locked(async () => {
      if (!this.mounted) {
        await this.mount(binding, files, session)
        return null
      }
      if (this.sessionId === null || session.sessionId === this.sessionId) return null
      return (
        `this sandbox shows session ${this.sessionId}'s view of the workspace; ` +
        `give session ${session.sessionId} a sandbox of its own`
      )
    })
    if (refusal !== null) return refusal
    const scoped = binding.capture().ns.scoped
    for (const prefix of this.own) {
      if (scoped?.(prefix) === true) {
        return `${prefix} is served by the sandbox itself, out of reach of this session's rules`
      }
    }
    return null
  }

  /** Unmount every served prefix and end its SFTP server. */
  close(): Promise<void> {
    return this.locked(() => this.unmount())
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task)
    this.lock = next.catch(() => undefined)
    return next
  }

  private async mount(
    binding: WorkspaceBinding,
    files: Files,
    session: SessionState,
  ): Promise<void> {
    const present = await this.table()
    const tops = topPrefixes(binding.resolver.prefixes())
    const own = tops.filter((p) => this.mountType !== 'ssh' && present.has(p))
    const served = tops.filter((p) => this.mountType !== 'fuse' && !own.includes(p))
    if (served.length > 0) await this.serveAll(served, files, session, present)
    this.own = own
    this.sessionId = served.length > 0 ? session.sessionId : null
    this.mounted = true
  }

  private async serveAll(
    prefixes: readonly string[],
    files: Files,
    session: SessionState,
    present: Map<string, string>,
  ): Promise<void> {
    const server = pipeServer
    if (server === null) throw new Error(PIPE_SERVER_HINT)
    if ((await this.run('command -v sshfs')).exitCode !== 0) {
      throw new Error(`${this.runtime}: ${SSHFS_HINT}`)
    }
    try {
      for (const prefix of prefixes) await this.serve(server, files, session, prefix, present)
    } catch (err) {
      await this.unmount()
      throw err
    }
  }

  private async serve(
    server: PipeServer,
    files: Files,
    session: SessionState,
    prefix: string,
    present: Map<string, string>,
  ): Promise<void> {
    const path = singleQuote(prefix)
    if (present.get(prefix) === 'fuse.sshfs') {
      await this.run(`fusermount3 -uz ${path} || fusermount -uz ${path}`)
    }
    const made = await this.run(
      `mkdir -p ${path} 2>/dev/null || { sudo -n mkdir -p ${path} && ` +
        `sudo -n chown "$(id -u):$(id -g)" ${path}; }`,
    )
    if (made.exitCode !== 0) {
      throw new Error(`${this.runtime}: cannot make ${prefix} in the sandbox: ${said(made.stderr)}`)
    }
    const log = singleQuote(`${SSHFS_LOG_PREFIX}_${crypto.randomUUID().replaceAll('-', '')}.log`)
    const source = singleQuote(`mirage:${prefix}`)
    const pipe = await this.openPipe(`exec sshfs -f -o ${SSHFS_OPTIONS} ${source} ${path} 2>${log}`)
    const entry: Served = { prefix, pipe, serving: Promise.resolve(), done: false }
    entry.serving = server(files, session, pipe.reader, pipe.writer).finally(() => {
      entry.done = true
    })
    this.served.push(entry)
    const deadline = Date.now() + MOUNT_WAIT_SECONDS * 1000
    while ((await this.table()).get(prefix) !== 'fuse.sshfs') {
      if (entry.done || Date.now() > deadline) {
        const written = await this.run(`cat ${log}`)
        throw new Error(`${this.runtime}: sshfs did not mount ${prefix}: ${said(written.stdout)}`)
      }
      await sleep(MOUNT_POLL_SECONDS * 1000)
    }
  }

  private async table(): Promise<Map<string, string>> {
    const listed = await this.run('cat /proc/mounts')
    if (listed.exitCode !== 0) {
      throw new Error(
        `${this.runtime}: cannot read the sandbox's mount table: ${said(listed.stderr)}`,
      )
    }
    return mountTable(DECODER.decode(listed.stdout))
  }

  private async unmount(): Promise<void> {
    const served = this.served
    this.served = []
    this.mounted = false
    this.sessionId = null
    this.own = []
    for (const { prefix, pipe, serving } of served) {
      const path = singleQuote(prefix)
      try {
        const done = await this.run(`fusermount3 -uz ${path} || fusermount -uz ${path}`)
        if (done.exitCode !== 0) {
          console.warn(
            `${this.runtime}: unmounting ${prefix} in the sandbox failed: ${said(done.stderr)}`,
          )
        }
        await pipe.stop()
        await within(serving, UNMOUNT_WAIT_SECONDS * 1000)
      } catch (err) {
        console.warn(`${this.runtime}: ending the SFTP server for ${prefix} failed:`, err)
      }
    }
  }
}
