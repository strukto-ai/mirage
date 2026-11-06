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

import {
  currentCaller,
  getCurrentSession,
  runWithCaller,
  type Caller,
} from '../../context/session_context.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { singleQuote } from '../../utils/quote.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { runDetached } from '../../utils/async_context.ts'
import type { Files } from '../../workspace/files.ts'
import type { SessionState } from '../../workspace/session/session.ts'
import { refusedRun, restrictedMountsFor, type WorkspaceBinding } from '../binding.ts'
import { CANNOT_EXECUTE_STATUS } from '../../shell/constants.ts'
import type { MountType, PipeWriter, RunResult, SandboxPipe } from '../types.ts'
import {
  MOUNT_GUARD,
  MOUNT_POLL_SECONDS,
  MOUNT_WAIT_SECONDS,
  PIPE_SERVER_HINT,
  SSHFS_HINT,
  SSHFS_LOG_PREFIX,
  SSHFS_OPTIONS,
  SSHFS_SOURCE_PREFIX,
  UNMOUNT_WAIT_SECONDS,
  mountField,
} from './constants.ts'

/** A served prefix's SFTP server, as `session` (node's PipeServer). */
export interface PipeServer {
  /** Answer the client's requests on its pipe until it closes it. */
  serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void>
  /** Land every write the client has been told is done. */
  sync(): Promise<void>
}

let pipeServer: Parameters<typeof registerPipeServer>[0] | null = null

/**
 * Where node puts the SFTP server a served prefix's pipe runs: as
 * `session`, each request run by `run`. Core has none of its own:
 * MountCore and ssh2 are node's.
 */
export function registerPipeServer(
  make: (
    files: Files,
    session: SessionState,
    run: (op: () => Promise<void>) => Promise<void>,
  ) => PipeServer,
): void {
  pipeServer = make
}

const DECODER = new TextDecoder()
const OCTAL_ESCAPE = /\\([0-7]{3})/g

function octalChar(_match: string, digits: string): string {
  return String.fromCharCode(parseInt(digits, 8))
}

/**
 * Each mountpoint a `/proc/mounts` lists, with its source and type. The
 * kernel escapes a space in a source or path as `\040`; that is undone. A
 * point mounted twice keeps the later (top) entry.
 */
export function mountTable(text: string): Map<string, [string, string]> {
  const table = new Map<string, [string, string]>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const [source, point, kind] = fields
    if (source !== undefined && point !== undefined && kind !== undefined) {
      table.set(point.replace(OCTAL_ESCAPE, octalChar), [
        source.replace(OCTAL_ESCAPE, octalChar),
        kind,
      ])
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

/** The sandbox command that lazily unmounts `prefix`. */
function unmountLine(prefix: string): string {
  const path = singleQuote(prefix)
  return `fusermount3 -uz ${path} || fusermount -uz ${path}`
}

/** Why a line did not run: the sandbox no longer holds `prefix`. */
function unmounted(runtime: string, prefix: string): string {
  return `${runtime}: ${prefix} is no longer mounted in the sandbox (did it restart?); the line did not run`
}

/**
 * The sandbox command that exits 0 while a program runs with `source` as
 * one of its arguments, as an sshfs serving it does, 1 once none does, and
 * 2 when it read no process at all. It reads `/proc`, never the mount, so a
 * mount whose server stalled cannot hang it, and hands awk the source in
 * its environment, never an argument, so the check never finds itself. A
 * newline inside an argument becomes `\001` on both sides, apart from the
 * NUL that ends each argument.
 */
export function runningLine(source: string): string {
  return (
    "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0\\n' '\\n\\001' | " +
    `S=${singleQuote(source.replaceAll('\n', '\x01'))} awk ` +
    `'BEGIN { s = ENVIRON["S"] } $0 == s { f = 1 } END { exit f ? 0 : NR ? 1 : 2 }'`
  )
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
  server: PipeServer
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
 * that ended is started again. While a rule reaches under a prefix, the
 * sandbox's own mounts are read again for each line, so one it mounted
 * since is refused too. A server runs outside the line that started it,
 * so it answers as the session alone and never with a grant that line was
 * given. What the host serves shows one session's view, and a program a line starts may outlive it, so under `ssh` and
 * `both` the sandbox belongs to the first session it serves or runs a line
 * for, until it is closed: a line of another session is refused rather
 * than shown, or showing, the first one's view, and so is a session made
 * again under the same id, which a program the first one started could
 * otherwise read through. Under `fuse` the host serves nothing, and any
 * session may run.
 *
 * Each sshfs source names the instance serving it (`mirage-<id>:<prefix>`),
 * so an instance unmounts only its own: a prefix another sshfs still
 * serves, as another workspace's runtime on the same sandbox does, refuses
 * the line (1) rather than being taken, and one whose sshfs has gone is
 * unmounted and served.
 *
 * A sandbox may restart between a line's admit and its exec and come back
 * without its mounts, so each line runs under `MOUNT_GUARD`, which checks
 * every mount it holds in the boot the program runs in and exits 126 with
 * nothing run when one is gone. The next line reads the mounts again: what
 * the host served is served again, and while a mount of the sandbox's own
 * is gone lines are refused (126) until the sandbox mounts it again, rather
 * than served over by the host. Under `fuse` the mounts are read on every
 * line until the sandbox holds every prefix, so one it mounts late is
 * guarded too.
 */
export class SandboxMounts {
  private session: SessionState | null = null
  // Each running line's write admission, and the served requests running on it.
  private readonly lines: (Pick<Caller, 'stop' | 'writeHeld'> & { lent: Set<Promise<void>> })[] = []
  private readonly served = new Map<string, Served>()
  private seen: string | null = null
  // The sandbox's own mounts as last read, and each prefix held since.
  private own = new Map<string, [string, string]>()
  private owned = new Set<string>()
  // What each served prefix was laid over (as JSON), shown again once its server ends.
  private readonly under = new Map<string, string>()
  private lock: Promise<unknown> = Promise.resolve()
  private readonly name = `${SSHFS_SOURCE_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`

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

  get fileEffectsDispatched(): boolean {
    return this.mountType === 'ssh'
  }

  /**
   * Bring the mounts in step, then refuse a line that may not run: one the
   * session's restrictions reach past the dispatcher is refused as a policy
   * refuses it (126), one from a cwd other than `/` that ssh serves no mount
   * for is refused before anything reaches the sandbox (126), one the
   * sandbox cannot serve because another session or another sshfs holds it,
   * or another mount covers it, fails (1), and one over a mount of the
   * sandbox's own that is gone is refused (126). Null when the line may run.
   */
  async admit(
    binding: WorkspaceBinding | null,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult | null> {
    const files = binding?.files ?? null
    const getSession = binding?.getSession ?? null
    const mountPrefixes = binding?.mountPrefixes ?? null
    if (binding === null || files === null || getSession === null || mountPrefixes === null) {
      throw new Error(`${this.runtime}: mountType needs the runtime in a workspace`)
    }
    const current = getCurrentSession()
    const rules = current?.commands
    if (
      rules != null &&
      [...rules.ask, ...rules.deny].some(
        (rule) => (rule.commands?.length ?? 0) > 0 && ((rule.paths?.length ?? 0) > 0 || rule.mount),
      )
    )
      return refusedRun(
        this.runtime,
        'this file transport cannot enforce program-specific path rules',
      )
    if (current === null) {
      throw new Error(
        `${this.runtime}: mountType serves a session's view, and this line runs as none`,
      )
    }
    const { stop, writeHeld } = currentCaller()
    this.lines.push({ stop, writeHeld, lent: new Set() })
    const seen = rstripSlash(cwd)
    if (
      this.mountType === 'ssh' &&
      seen !== '' &&
      ![...mountPaths(mountPrefixes())].some((p) => seen === p || seen.startsWith(`${p}/`))
    )
      return {
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(
          `${this.runtime}: the sandbox cannot see the working directory ${seen}; cd into a mount first\n`,
        ),
        exitCode: CANNOT_EXECUTE_STATUS,
      }
    return this.locked(async () => {
      const served = this.session
      const session = getSession(current.sessionId)
      if (served !== null && served !== session) {
        const earlier = served.sessionId === current.sessionId ? 'an earlier ' : ''
        return {
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(
            `${this.runtime}: this sandbox shows ${earlier}session ${served.sessionId}'s view ` +
              `of the workspace; give session ${current.sessionId} a sandbox of its own\n`,
          ),
          exitCode: 1,
        }
      }
      const every = mountPaths(mountPrefixes())
      const ruled = new Set(
        restrictedMountsFor(current, mountPrefixes()).map((prefix) => rstripSlash(prefix) || '/'),
      )
      const refused = await this.reconcile(binding, files, session, every, ruled, signal)
      if (refused !== null) {
        return {
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(`${this.runtime}: ${refused}\n`),
          exitCode: 1,
        }
      }
      const lost = this.lost()
      if (lost !== null) {
        return {
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(`${unmounted(this.runtime, lost)}\n`),
          exitCode: CANNOT_EXECUTE_STATUS,
        }
      }
      const unserved = this.unserved(ruled)
      if (this.mountType !== 'fuse' && (!unserved || this.served.size > 0)) {
        this.session = session
      }
      return unserved
        ? refusedRun(
            this.runtime,
            'a mount this session restricts is not served through the dispatcher',
          )
        : null
    })
  }

  /**
   * `argv` under `MOUNT_GUARD`, holding every mount the sandbox had at the
   * line's admit; unchanged when it had none.
   */
  guarded(argv: readonly string[]): readonly string[] {
    const held = new Map<string, [string, string]>(
      [...this.served.keys()].map((p) => [p, [this.source(p), 'fuse.sshfs']]),
    )
    for (const [p, entry] of this.own) held.set(p, entry)
    if (held.size === 0) return argv
    const words = [...held]
      .sort(([a], [b]) => compareCodePoints(a, b))
      .flatMap(([prefix, [source, kind]]) => [
        mountField(prefix),
        mountField(source, true),
        kind,
        unmounted(this.runtime, prefix),
      ])
    return ['/bin/sh', '-c', MOUNT_GUARD, 'sh', '/proc/mounts', ...words, '--', ...argv]
  }

  /**
   * Read the mounts again on the next line: a guarded line found one gone,
   * or its program exited as the guard does.
   */
  forget(): void {
    this.seen = null
  }

  /** Unmount every served prefix and end its SFTP server. */
  close(): Promise<void> {
    return this.locked(async () => {
      await this.unmount()
      this.session = null
    })
  }

  /**
   * Land every write a served prefix's server has acknowledged.
   *
   * sshfs answers close(2) once the file's writes are acknowledged and
   * sends the SFTP close that lands them afterwards, so a line can end
   * before they land. Its programs have closed their files by then, so
   * this lands every one, outside the line as that close would, and
   * `fileEffectsDispatched` holds. Each landing keeps the line's write
   * admission alone: a capture waiting for the line lets it through rather
   * than waiting on it. Then the line lends its admission to no more
   * requests, and waits out the ones it lent it to, so a capture never
   * reads past one still running.
   */
  async sync(): Promise<void> {
    const { stop, writeHeld } = currentCaller()
    try {
      for (const { server } of [...this.served.values()]) {
        await runDetached(() =>
          runWithCaller({ ...currentCaller(), stop, writeHeld }, () => server.sync()),
        )
      }
    } finally {
      const index = this.lines.findIndex((held) => held.stop === stop)
      const [line] = index >= 0 ? this.lines.splice(index, 1) : []
      if (line !== undefined) await Promise.all(line.lent)
    }
  }

  /**
   * Run one served request with the write admission of the latest line
   * running in the sandbox, from its `admit` to its `sync`, and none
   * between lines. A program's file op then counts as its line's, so a
   * capture waiting for that line lets it land rather than holding it while
   * the line waits on it.
   */
  private async lend(op: () => Promise<void>): Promise<void> {
    const line = this.lines.at(-1)
    if (line === undefined) return op()
    let done = (): void => undefined
    const running = new Promise<void>((resolve) => {
      done = resolve
    })
    line.lent.add(running)
    try {
      await runWithCaller({ ...currentCaller(), stop: line.stop, writeHeld: line.writeHeld }, op)
    } finally {
      line.lent.delete(running)
      done()
    }
  }

  private unserved(ruled: ReadonlySet<string>): boolean {
    return [...ruled].some(
      (prefix) =>
        ![...this.served.keys()].some(
          (p) => prefix === p || prefix.startsWith(p.replace(/\/$/, '') + '/'),
        ),
    )
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task)
    this.lock = next.catch(() => undefined)
    return next
  }

  /**
   * Serve what the session sees and drop what it no longer does. Returns
   * why the line may not run, a prefix another sshfs still serves or another
   * mount covers, which is left alone and nothing new served, or null once
   * in step, or with a mount of the sandbox's own gone, which `admit`
   * refuses.
   */
  private async reconcile(
    binding: WorkspaceBinding,
    files: Files,
    session: SessionState,
    every: Set<string>,
    ruled: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const visible = this.mountType === 'fuse' ? [] : topPrefixes(binding.resolver.prefixes())
    const seen = JSON.stringify([[...every].sort(compareCodePoints), visible])
    const ended = [...this.served].filter(([, entry]) => entry.ended).map(([prefix]) => prefix)
    if (
      this.seen === seen &&
      ended.length === 0 &&
      (this.mountType === 'ssh' || ruled.size === 0)
    ) {
      return null
    }
    this.seen = null
    const present = await this.table(signal)
    for (const p of this.served.keys()) if (!ended.includes(p) && !present.has(p)) ended.push(p)
    const own = [...every]
      .filter(
        (p) =>
          this.mountType !== 'ssh' &&
          present.has(p) &&
          !this.served.has(p) &&
          !(
            present.get(p)?.[1] === 'fuse.sshfs' &&
            (present.get(p)?.[0] ?? '').startsWith(SSHFS_SOURCE_PREFIX)
          ),
      )
      .sort(compareCodePoints)
    this.own = new Map(own.map((p) => [p, present.get(p) ?? ['', '']]))
    this.owned = new Set([...[...this.owned].filter((p) => every.has(p)), ...own])
    if (this.lost() !== null) return null
    const wanted = visible.filter((p) => !own.includes(p))
    const covered = [...this.served.keys()].sort(compareCodePoints).find((p) => {
      const entry = present.get(p)
      return (
        wanted.includes(p) &&
        entry !== undefined &&
        (entry[0] !== this.source(p) || entry[1] !== 'fuse.sshfs') &&
        (!ended.includes(p) || entry[1] !== 'fuse.sshfs') &&
        !(ended.includes(p) && JSON.stringify(entry) === this.under.get(p))
      )
    })
    if (covered !== undefined) {
      return `another mount covers ${covered} in this sandbox; the line did not run`
    }
    for (const prefix of wanted) {
      const under = own.find((o) => o.startsWith(prefix + '/'))
      if (under !== undefined) {
        throw new Error(
          `${this.runtime}: the sandbox mounts ${under} itself, and serving ${prefix} would cover it`,
        )
      }
    }
    for (const prefix of [...this.served.keys()]) {
      if (!wanted.includes(prefix) || ended.includes(prefix)) await this.drop(prefix, present)
    }
    const fresh = wanted.filter((p) => !this.served.has(p))
    for (const prefix of fresh) {
      if (await this.held(prefix, present, signal)) {
        return `another sshfs serves ${prefix} in this sandbox; give this workspace a sandbox of its own`
      }
    }
    if (fresh.length > 0) {
      const make = pipeServer
      if (make === null) throw new Error(PIPE_SERVER_HINT)
      if ((await this.run('command -v sshfs', signal)).exitCode !== 0) {
        throw new Error(`${this.runtime}: ${SSHFS_HINT}`)
      }
      try {
        for (const prefix of fresh) {
          await this.serve(
            make(files, session, (op) => this.lend(op)),
            prefix,
            present,
            signal,
          )
        }
      } catch (err) {
        await this.unmount()
        throw err
      }
    }
    if (this.mountType !== 'fuse' || topPrefixes(every).every((p) => own.includes(p))) {
      this.seen = seen
    }
    return null
  }

  private source(prefix: string): string {
    return `${this.name}:${prefix}`
  }

  /**
   * A mount of the sandbox's own it held and no longer does; the prefixes
   * held are kept only while the workspace mounts them.
   */
  private lost(): string | null {
    return [...this.owned].sort(compareCodePoints).find((p) => !this.own.has(p)) ?? null
  }

  /** Whether another sshfs still serves `prefix`. */
  private async held(
    prefix: string,
    present: ReadonlyMap<string, [string, string]>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const [source, kind] = present.get(prefix) ?? ['', '']
    if (kind !== 'fuse.sshfs' || source === this.source(prefix)) return false
    const found = await this.run(runningLine(source), signal)
    if (found.exitCode !== 0 && found.exitCode !== 1) {
      throw new Error(
        `${this.runtime}: cannot tell whether ${source} is served: ${said(found.stderr)}`,
      )
    }
    return found.exitCode === 0
  }

  private async serve(
    server: PipeServer,
    prefix: string,
    present: ReadonlyMap<string, [string, string]>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.under.set(prefix, JSON.stringify(present.get(prefix) ?? null))
    if (present.get(prefix)?.[1] === 'fuse.sshfs') await this.run(unmountLine(prefix), signal)
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
    const source = singleQuote(this.source(prefix))
    const pipe = await this.openPipe(`exec sshfs -f -o ${SSHFS_OPTIONS} ${source} ${path} 2>${log}`)
    const entry: Served = { pipe, server, serving: Promise.resolve(), ended: false, failure: null }
    entry.serving = Promise.resolve(runDetached(() => server.serve(pipe.reader, pipe.writer))).then(
      () => {
        entry.ended = true
      },
      (err: unknown) => {
        entry.ended = true
        entry.failure = err instanceof Error ? err : new Error(String(err))
      },
    )
    this.served.set(prefix, entry)
    try {
      const deadline = Date.now() + MOUNT_WAIT_SECONDS * 1000
      for (;;) {
        try {
          const [source, kind] = (await this.table(signal)).get(prefix) ?? ['', '']
          if (source === this.source(prefix) && kind === 'fuse.sshfs') return
        } catch (error) {
          signal?.throwIfAborted()
          const diagnostic = (await pipe.diagnostic?.()) ?? ''
          if (diagnostic) {
            const said = error instanceof Error ? error.message : String(error)
            throw new Error(
              `${this.runtime}: sshfs did not mount ${prefix}: ${said}; helper said: ${diagnostic}`,
              { cause: error },
            )
          }
          throw error
        }
        if (entry.ended || Date.now() > deadline) {
          const diagnostic = (await pipe.diagnostic?.()) ?? ''
          let reason = diagnostic
          try {
            const written = await this.run(`cat ${log}`, signal)
            const logText = said(written.stdout)
            if (logText) reason = logText + (diagnostic ? `; helper said: ${diagnostic}` : '')
          } catch (error) {
            signal?.throwIfAborted()
            console.debug(`${this.runtime}: reading the sshfs log failed`, error)
            if (!reason) reason = `cannot read the sshfs log: ${String(error)}`
          }
          reason ||= 'no word from sshfs'
          if (entry.failure !== null) reason += `; the SFTP server failed: ${entry.failure.message}`
          throw new Error(`${this.runtime}: sshfs did not mount ${prefix}: ${reason}`)
        }
        signal?.throwIfAborted()
        await sleep(MOUNT_POLL_SECONDS * 1000)
      }
    } finally {
      if (signal?.aborted !== true) await this.dropLog(log)
    }
  }

  /** Remove the helper's setup log; keeping it only costs a file. */
  private async dropLog(log: string): Promise<void> {
    try {
      const removed = await this.run(`rm -f -- ${log}`)
      if (removed.exitCode !== 0) console.debug('could not remove sshfs log:', said(removed.stderr))
    } catch (err) {
      console.debug('could not remove sshfs log:', err)
    }
  }

  private async table(signal?: AbortSignal): Promise<Map<string, [string, string]>> {
    const listed = await this.run('cat /proc/mounts', signal)
    if (listed.exitCode !== 0) {
      throw new Error(
        `${this.runtime}: cannot read the sandbox's mount table: ${said(listed.stderr)}`,
      )
    }
    return mountTable(DECODER.decode(listed.stdout))
  }

  /**
   * Unmount `prefix` if the mount on top is still this instance's, then end
   * its SFTP server.
   */
  private async drop(
    prefix: string,
    present: ReadonlyMap<string, [string, string]>,
  ): Promise<void> {
    const entry = this.served.get(prefix)
    if (entry === undefined) return
    this.served.delete(prefix)
    this.under.delete(prefix)
    if (present.get(prefix)?.[0] === this.source(prefix)) {
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
    let present = new Map<string, [string, string]>()
    if (this.served.size > 0) {
      try {
        present = await this.table()
      } catch (err) {
        console.warn(
          `${this.runtime}: reading the mount table to unmount failed; unmounting every served prefix:`,
          err,
        )
        present = new Map([...this.served.keys()].map((p) => [p, [this.source(p), 'fuse.sshfs']]))
      }
    }
    for (const prefix of [...this.served.keys()]) await this.drop(prefix, present)
    this.seen = null
  }
}
