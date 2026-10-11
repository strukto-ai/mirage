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
import { MountMode } from '../../types.ts'
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

/** The mountpoints a sandbox could hold of `prefixes`. */
function mountPaths(prefixes: Iterable<string>): Set<string> {
  const paths = new Set<string>()
  for (const prefix of prefixes) paths.add(rstripSlash(prefix))
  paths.delete('')
  paths.delete('/dev')
  return paths
}

/**
 * The prefixes a sandbox mounts: each one under no other. A prefix under
 * another is served through it. The root and the workspace's devices are
 * left out: a sandbox's `/` and `/dev` are its own, and nothing can be
 * mounted over them.
 */
export function topPrefixes(prefixes: Iterable<string>): string[] {
  const tops: string[] = []
  for (const prefix of [...mountPaths(prefixes)].sort(compareCodePoints)) {
    if (!tops.some((top) => prefix.startsWith(top + '/'))) tops.push(prefix)
  }
  return tops
}

/** Whether the session's profile narrows the mode of `prefix` or of a mount under it. */
function cappedUnder(session: SessionState, prefix: string): boolean {
  for (const [path, mode] of session.mountModes ?? []) {
    if (mode !== MountMode.EXEC && (path === prefix || path.startsWith(prefix + '/'))) return true
  }
  return false
}

/** The sandbox command that lazily unmounts `prefix`. */
function unmountLine(prefix: string): string {
  const path = singleQuote(prefix)
  return `fusermount3 -uz ${path} || fusermount -uz ${path}`
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
  pipe: SandboxPipe
  // Settles when the server ends, never rejecting: `failure` says why.
  serving: Promise<void>
  ended: boolean
  failure: Error | null
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
 * reach, so a line is refused while a hide, rule or mode cap covers
 * anything under one, hidden mounts included.
 *
 * Each line first brings the mounts in step with the workspace: a mount
 * added or shown since is served, one hidden is dropped, and a server
 * that ended is started again. What the host serves shows one session's
 * view, and a program a line starts may outlive it, so under `ssh` and
 * `both` the sandbox belongs to the first session it serves or runs a line
 * for, until it is closed: a line of another session is refused rather
 * than shown, or showing, the first one's view. Under `fuse` the host
 * serves nothing, and any session may run.
 */
export class SandboxMounts {
  private sessionId: string | null = null
  private own: readonly string[] = []
  private readonly served = new Map<string, Served>()
  private seen: string | null = null
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
    private readonly run: (line: string, signal?: AbortSignal) => Promise<RunResult>,
    private readonly openPipe: (command: string) => Promise<SandboxPipe>,
  ) {}

  /** Bring the mounts in step, then say why a line may not run, or null when it may. */
  async admit(binding: WorkspaceBinding | null, signal?: AbortSignal): Promise<string | null> {
    const files = binding?.files ?? null
    const getSession = binding?.getSession ?? null
    const mountPrefixes = binding?.mountPrefixes ?? null
    if (binding === null || files === null || getSession === null || mountPrefixes === null) {
      throw new Error(`${this.runtime}: mountType needs the runtime in a workspace`)
    }
    const current = getCurrentSession()
    if (current === null) {
      throw new Error(
        `${this.runtime}: mountType serves a session's view, and this line runs as none`,
      )
    }
    return this.locked(async () => {
      if (this.sessionId !== null && current.sessionId !== this.sessionId) {
        return (
          `this sandbox shows session ${this.sessionId}'s view of the workspace; ` +
          `give session ${current.sessionId} a sandbox of its own`
        )
      }
      await this.reconcile(
        binding,
        files,
        getSession(current.sessionId),
        mountPaths(mountPrefixes()),
        signal,
      )
      const refusal = this.refusal(binding.capture().ns.scoped, current)
      if (this.mountType !== 'fuse' && (refusal === null || this.served.size > 0)) {
        this.sessionId = current.sessionId
      }
      return refusal
    })
  }

  /** Unmount every served prefix and end its SFTP server. */
  close(): Promise<void> {
    return this.locked(async () => {
      await this.unmount()
      this.sessionId = null
    })
  }

  private refusal(
    scoped: ((path: string) => boolean) | undefined,
    session: SessionState,
  ): string | null {
    for (const prefix of this.own) {
      if (scoped?.(prefix) === true || cappedUnder(session, prefix)) {
        return `${prefix} is served by the sandbox itself, out of reach of this session's rules`
      }
    }
    return null
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task)
    this.lock = next.catch(() => undefined)
    return next
  }

  private async reconcile(
    binding: WorkspaceBinding,
    files: Files,
    session: SessionState,
    every: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const visible = this.mountType === 'fuse' ? [] : topPrefixes(binding.resolver.prefixes())
    const seen = JSON.stringify([[...every].sort(compareCodePoints), visible])
    const ended = [...this.served].filter(([, entry]) => entry.ended).map(([prefix]) => prefix)
    if (this.seen === seen && ended.length === 0) return
    const present = await this.table(signal)
    const own = [...every]
      .filter((p) => this.mountType !== 'ssh' && present.has(p) && !this.served.has(p))
      .sort(compareCodePoints)
    const wanted = visible.filter((p) => !own.includes(p))
    for (const prefix of wanted) {
      const under = own.find((o) => o.startsWith(prefix + '/'))
      if (under !== undefined) {
        throw new Error(
          `${this.runtime}: the sandbox mounts ${under} itself, and serving ${prefix} would cover it`,
        )
      }
    }
    for (const prefix of [...this.served.keys()]) {
      if (!wanted.includes(prefix) || ended.includes(prefix)) await this.drop(prefix)
    }
    const fresh = wanted.filter((p) => !this.served.has(p))
    if (fresh.length > 0) {
      const server = pipeServer
      if (server === null) throw new Error(PIPE_SERVER_HINT)
      if ((await this.run('command -v sshfs', signal)).exitCode !== 0) {
        throw new Error(`${this.runtime}: ${SSHFS_HINT}`)
      }
      try {
        for (const prefix of fresh) {
          await this.serve(server, files, session, prefix, present, signal)
        }
      } catch (err) {
        await this.unmount()
        throw err
      }
    }
    this.own = own
    this.seen = seen
  }

  private async serve(
    server: PipeServer,
    files: Files,
    session: SessionState,
    prefix: string,
    present: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (present.get(prefix) === 'fuse.sshfs') await this.run(unmountLine(prefix), signal)
    const path = singleQuote(prefix)
    const made = await this.run(
      `mkdir -p ${path} 2>/dev/null || { sudo -n mkdir -p ${path} && ` +
        `sudo -n chown "$(id -u):$(id -g)" ${path}; }`,
      signal,
    )
    if (made.exitCode !== 0) {
      throw new Error(`${this.runtime}: cannot make ${prefix} in the sandbox: ${said(made.stderr)}`)
    }
    const log = singleQuote(`${SSHFS_LOG_PREFIX}_${crypto.randomUUID().replaceAll('-', '')}.log`)
    const source = singleQuote(`mirage:${prefix}`)
    const pipe = await this.openPipe(`exec sshfs -f -o ${SSHFS_OPTIONS} ${source} ${path} 2>${log}`)
    const entry: Served = { pipe, serving: Promise.resolve(), ended: false, failure: null }
    entry.serving = server(files, session, pipe.reader, pipe.writer).then(
      () => {
        entry.ended = true
      },
      (err: unknown) => {
        entry.ended = true
        entry.failure = err instanceof Error ? err : new Error(String(err))
      },
    )
    this.served.set(prefix, entry)
    const deadline = Date.now() + MOUNT_WAIT_SECONDS * 1000
    while ((await this.table(signal)).get(prefix) !== 'fuse.sshfs') {
      if (entry.ended || Date.now() > deadline) {
        const written = await this.run(`cat ${log}`, signal)
        let reason = said(written.stdout) || 'no word from sshfs'
        if (entry.failure !== null) reason += `; the SFTP server failed: ${entry.failure.message}`
        throw new Error(`${this.runtime}: sshfs did not mount ${prefix}: ${reason}`)
      }
      signal?.throwIfAborted()
      await sleep(MOUNT_POLL_SECONDS * 1000)
    }
  }

  private async table(signal?: AbortSignal): Promise<Map<string, string>> {
    const listed = await this.run('cat /proc/mounts', signal)
    if (listed.exitCode !== 0) {
      throw new Error(
        `${this.runtime}: cannot read the sandbox's mount table: ${said(listed.stderr)}`,
      )
    }
    return mountTable(DECODER.decode(listed.stdout))
  }

  private async drop(prefix: string): Promise<void> {
    const entry = this.served.get(prefix)
    if (entry === undefined) return
    this.served.delete(prefix)
    try {
      const done = await this.run(unmountLine(prefix))
      if (done.exitCode !== 0) {
        console.warn(
          `${this.runtime}: unmounting ${prefix} in the sandbox failed: ${said(done.stderr)}`,
        )
      }
    } catch (err) {
      console.warn(`${this.runtime}: unmounting ${prefix} in the sandbox failed:`, err)
    }
    try {
      await entry.pipe.stop()
      await within(entry.serving, UNMOUNT_WAIT_SECONDS * 1000)
      if (entry.failure !== null) throw entry.failure
    } catch (err) {
      console.warn(`${this.runtime}: ending the SFTP server for ${prefix} failed:`, err)
    }
  }

  private async unmount(): Promise<void> {
    for (const prefix of [...this.served.keys()]) await this.drop(prefix)
    this.own = []
    this.seen = null
  }
}
