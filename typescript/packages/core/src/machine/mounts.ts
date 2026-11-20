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
  bindCaller,
  type Caller,
} from '../context/session_context.ts'
import { strerrorOf } from '../errors/fs.ts'
import { rstripSlash } from '../utils/slash.ts'
import { singleQuote } from '../utils/quote.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { abortable, mergeSignals } from '../utils/abort.ts'
import { runDetached } from '../utils/async_context.ts'
import { SERVED_BY } from '../mount/changes.ts'
import type { ServedPrefix } from '../mount/types.ts'
import { ruleTable } from '../rs/policy.ts'
import { FileType } from '../types.ts'
import { readerOf, type Files } from '../workspace/files.ts'
import type { MountRow } from '../workspace/types.ts'
import type { SessionState } from '../workspace/session/session.ts'
import { refusedRun, restrictedMountsFor, type WorkspaceBinding } from '../runtime/binding.ts'
import { CANNOT_EXECUTE_STATUS } from '../shell/constants.ts'
import type { MachinePipe, MountType, Transport } from './types.ts'
import type { OutputFn, PipeWriter, RunAnswer, RunResult } from '../runtime/types.ts'
import {
  DARWIN_ADMIN_STATUS,
  DARWIN_MOUNT_GUARD,
  FSPROTO_SERVER_HINT,
  MACFUSE_KIND,
  MIRAGE_FUSE_FIND,
  MIRAGE_FUSE_HINT,
  MIRAGE_FUSE_LINE,
  MOUNT_GUARD,
  MOUNT_POLL_SECONDS,
  MOUNT_WAIT_SECONDS,
  PIPE_SERVER_HINT,
  SERVED_KINDS,
  SSHFS_HINT,
  SSHFS_LINE,
  SSHFS_LINKS_OPTION,
  SSHFS_OPTIONS,
  SSHFS_SOURCE_PREFIX,
  UNMOUNT_WAIT_SECONDS,
  darwinAdminHint,
  darwinKillLine,
  darwinMountTable,
  darwinMountpointLine,
  darwinRunningLine,
  darwinTableLine,
  darwinUnmountLine,
  machineDirLine,
  mountField,
} from './constants.ts'

export const logger: { debug?: (message: string) => void } = {}

/**
 * A served prefix's file server, as `session`: `mount/sftp`'s PipeServer
 * for sshfs, `mount/fsproto`'s FsprotoServer for mirage-fuse.
 */
export interface PipeServer {
  /** Answer the client's requests on its pipe until it closes it. */
  serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void>
  /** Land every write the client has been told is done; the path and error of each landing that failed since the last sync. */
  sync(): Promise<[string, unknown][]>
  /** Wait until the client has applied every change noted so far, false when it did not answer in time; sshfs keeps nothing to apply them to. */
  begin?(): Promise<boolean>
}

const pipeServers = new Map<Transport, Parameters<typeof registerPipeServer>[1]>()

/**
 * Where a host puts the file server a served prefix's pipe runs for a
 * transport: as `session`, each request run by `run`. Importing
 * `mount/sftp` registers sshfs's, `mount/fsproto` mirage-fuse's; the
 * browser, which cannot run ssh2, registers none.
 */
export function registerPipeServer(
  transport: Transport,
  make: (
    files: Files,
    session: SessionState,
    run: (op: () => Promise<void>) => Promise<void>,
    served: ServedPrefix,
  ) => PipeServer,
): void {
  pipeServers.set(transport, make)
}

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()
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

/** The mountpoints a machine could hold of `prefixes`. */
function mountPaths(prefixes: Iterable<string>): Set<string> {
  const paths = new Set<string>()
  for (const prefix of prefixes) paths.add(rstripSlash(prefix))
  paths.delete('')
  paths.delete('/dev')
  return paths
}

/**
 * The prefixes a machine mounts: each one under no other. A prefix under
 * another is served through it. The root and the workspace's devices are
 * left out: a machine's `/` and `/dev` are its own, and nothing can be
 * mounted over them.
 */
export function topPrefixes(prefixes: Iterable<string>): string[] {
  const tops: string[] = []
  for (const prefix of [...mountPaths(prefixes)].sort(compareCodePoints)) {
    if (!tops.some((top) => prefix.startsWith(top + '/'))) tops.push(prefix)
  }
  return tops
}

/**
 * The prefixes ssh serves a machine: its top prefixes but those it holds
 * itself. A machine mount of the machine's own files at the path they have
 * there (`/tmp`, `"@<machine>"`) stays the machine's: serving it would cover the
 * very files it shows. A mount under one is still served at its own path.
 *
 * @param prefixes the mount prefixes the session sees.
 * @param local the prefixes the machine holds itself.
 */
export function servedPrefixes(prefixes: Iterable<string>, local: Iterable<string> = []): string[] {
  const own = new Set([...local].map((p) => rstripSlash(p)))
  return topPrefixes([...prefixes].filter((p) => !own.has(rstripSlash(p))))
}

/** `text` with each byte of a character outside `[A-Za-z0-9-]` written `_xx`. */
function escapeName(text: string): string {
  return text.replace(/[^A-Za-z0-9-]/gu, (c) =>
    [...ENCODER.encode(c)].map((b) => `_${b.toString(16).padStart(2, '0')}`).join(''),
  )
}

/**
 * The name the sshfs sources of one machine entry of a workspace start
 * with: `mirage-<workspace id>.<machine>`, each escaped (`escapeName`) so no
 * two pairs share a name, `.` never occurs inside either, and the name
 * stays one word in `/proc/mounts` and a shell line.
 */
export function sourceName(workspaceId: string, machine: string): string {
  return `${SSHFS_SOURCE_PREFIX}${escapeName(workspaceId)}.${escapeName(machine)}`
}

/** The machine command that lazily unmounts `prefix`. */
function unmountLine(prefix: string): string {
  const path = singleQuote(prefix)
  return `fusermount3 -uz ${path} || fusermount -uz ${path}`
}

/**
 * The pipe command that mounts `source` at `prefix` with sshfs, its errors in
 * `log`. It passes SSHFS_LINKS_OPTION only when the machine's sshfs names it in
 * its help, which reads no input, so the pipe's stream is sshfs's alone. Each
 * file shows as the machine user's own, as on a disk that user mounted: the
 * host's uid means nothing there, and git refuses a repository another user
 * owns. The modes stay the workspace's. Mirrors Python's `sshfs_line`.
 */
export function sshfsLine(source: string, prefix: string, log: string): string {
  return (
    `o=${SSHFS_OPTIONS}; case "$(sshfs -h 2>&1)" in ` +
    `*${SSHFS_LINKS_OPTION}*) o="$o,${SSHFS_LINKS_OPTION}";; esac; ` +
    'u=$(id -u 2>/dev/null) && g=$(id -g 2>/dev/null) && o="$o,uid=$u,gid=$g"; ' +
    `exec sshfs -f -o "$o" ${singleQuote(source)} ${singleQuote(prefix)} ` +
    `2>${singleQuote(log)}`
  )
}

/**
 * The pipe command that mounts `source` at `prefix` with mirage-fuse, found
 * in Mirage's folder on the machine or on its PATH (`MIRAGE_FUSE_FIND`),
 * its errors in `log`. Its stdin and stdout are the fsproto stream. Mirrors
 * Python's `mirage_fuse_line`.
 */
export function mirageFuseLine(source: string, prefix: string, log: string): string {
  return (
    `${MIRAGE_FUSE_FIND}exec "$f" serve ${singleQuote(source)} ${singleQuote(prefix)} ` +
    `2>${singleQuote(log)}`
  )
}

/** Why a line did not run: the machine no longer holds `prefix`. */
function unmounted(provider: string, prefix: string): string {
  return `${provider}: ${prefix} is no longer mounted in the machine (did it restart?); the line did not run`
}

/**
 * Why a line did not run: the machine's file client did not confirm in time
 * that it dropped what the workspace changed under `prefix`. Mirrors
 * Python's `unconfirmed`.
 */
function unconfirmed(provider: string, prefix: string): string {
  return `${provider}: the machine did not confirm the workspace's changes under ${prefix} in time; the line did not run`
}

/**
 * The machine command that exits 0 while a program runs with `source` as
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

/**
 * The machine command that kills every program with `source` as one of its
 * arguments, as an sshfs serving it has, reading `/proc` as `runningLine`
 * does, so it never kills itself. SIGKILL: what the server never answered
 * can no longer land, and only the daemon's death frees a program blocked
 * on the mount.
 */
export function killLine(source: string): string {
  return (
    "for p in /proc/[0-9]*; do tr '\\0\\n' '\\n\\001' <\"$p/cmdline\" 2>/dev/null | " +
    `S=${singleQuote(source.replaceAll('\n', '\x01'))} awk ` +
    `'BEGIN { s = ENVIRON["S"] } $0 == s { f = 1 } END { exit !f }' && ` +
    'kill -KILL "${p#/proc/}" 2>/dev/null; done; :'
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
  // The sshfs's source, its own to this serve.
  source: string
  pipe: MachinePipe
  server: PipeServer
  // Settles when the server ends, never rejecting: `failure` says why.
  serving: Promise<void>
  ended: boolean
  failure: Error | null
}

/**
 * The workspace prefixes one machine sees, by its `mountType`.
 *
 * `ssh`: every prefix the session sees is served from the host over SFTP,
 * and the machine mounts each with `sshfs -o passive` on a pipe the
 * provider holds open, so every file op in the machine is an op of the
 * session, held to its hides, modes and policies. `fuse`: a mirage in the
 * machine serves its prefixes itself and the host serves none. `both`: a
 * prefix the machine already mounts is its own, and the host serves the
 * rest. A prefix the machine serves itself is out of the session's rules'
 * reach, so a line is refused while a hide, rule or mode cap covers
 * anything under one, hidden mounts included.
 *
 * Each line first brings the mounts in step with the workspace: a mount
 * added or shown since is served, one hidden is dropped, and a server
 * that ended is started again. While a rule reaches under a prefix, the
 * machine's own mounts are read again for each line, so one it mounted
 * since is refused too. A server runs outside the line that started it,
 * so it answers as the session alone and never with a grant that line was
 * given. What the host serves shows one session's view, and a program a line starts may outlive it, so under `ssh` and
 * `both` the machine belongs to the first session it serves or runs a line
 * for, until it is closed: a line of another session is refused rather
 * than shown, or showing, the first one's view, and so is a session made
 * again under the same id, which a program the first one started could
 * otherwise read through. Under `fuse` the host serves nothing, and any
 * session may run.
 *
 * Each sshfs source names the workspace and machine entry serving it, the
 * instance and the serve (`mirage-<workspace id>.<machine>-<instance>-<n>:<prefix>`,
 * `sourceName`), so an instance unmounts only its own, and kills only the
 * sshfs of a server that ended, never one a later instance serves: a prefix another sshfs still serves, as another workspace, or
 * another machine entry on the same machine, does, refuses the line (1)
 * rather than being taken, and one whose sshfs has gone is unmounted and
 * served. A prefix whose sshfs carries this entry's own name but which this
 * instance does not serve was left by an instance before a restart: its
 * sshfs is killed, the prefix unmounted and served again. Workspace ids must
 * therefore be unique among live workspaces, and stable across a restart
 * for it to take its mounts back. A workspace with no id names its sources
 * at random. The session that owns the machine is held in memory, so after
 * a restart the first session to run a line owns it again.
 *
 * A machine may restart between a line's admit and its exec and come back
 * without its mounts, so each line runs under `MOUNT_GUARD`, which checks
 * every mount it holds in the boot the program runs in and exits 126 with
 * nothing run when one is gone. The next line reads the mounts again: what
 * the host served is served again, and while a mount of the machine's own
 * is gone lines are refused (126) until the machine mounts it again, rather
 * than served over by the host. Under `fuse` the mounts are read on every
 * line until the machine holds every prefix, so one it mounts late is
 * guarded too.
 */
/**
 * Whether `source`, mounted at `prefix`, has the shape every workspace gives
 * the mounts it serves, `<name>-<instance>-<n>:<prefix>`, so a Mac's macFUSE
 * mount, whose type names no program, can be told for one of Mirage's.
 * Mirrors Python's `mirage_source`.
 *
 * @param source a mount's source.
 * @param prefix its mountpoint.
 */
export function mirageSource(source: string, prefix: string): boolean {
  if (!source.endsWith(`:${prefix}`)) return false
  return /.-[0-9a-f]{8}-[0-9]+$/.test(source.slice(0, source.length - prefix.length - 1))
}

export class MachineMounts {
  private session: SessionState | null = null
  // Each running line's write admission, and the served requests running on it.
  private readonly lines: (Pick<Caller, 'stop' | 'writeHeld'> & { lent: Set<Promise<void>> })[] = []
  private readonly served = new Map<string, Served>()
  private seen: string | null = null
  // The machine's own mounts as last read, and each prefix held since.
  private own = new Map<string, [string, string]>()
  private owned = new Set<string>()
  // What each served prefix was laid over (as JSON), shown again once its server ends.
  private readonly under = new Map<string, string>()
  private lock: Promise<unknown> = Promise.resolve()
  private readonly random = `${SSHFS_SOURCE_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`
  private name = this.random
  // The prefixes served so far, numbering each sshfs's source, and each source started.
  // The instance's own token in each, so a kill an earlier instance left
  // running reaches none of this one's.
  private readonly instance = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  private serves = 0
  private readonly sources = new Set<string>()
  // Whether each top prefix is a directory, read once per mount: keyed by
  // the mount's row, which the registry builds anew whenever its mounts change.
  private readonly directories = new Map<string, { row: MountRow | null; directory: boolean }>()
  // Each kill of an ended server's sshfs still running, which close stops.
  private readonly kills = new Set<AbortController>()
  // When each served sshfs source's mount began keeping answers, so a change
  // made before it is not waited out.
  private since = new Map<string, number>()
  // Whether the machine is a Mac, asked once; there each prefix the table is
  // read for, and the real path each mounts at.
  private darwin: boolean | null = null
  private readonly looked = new Set<string>()
  private readonly points = new Map<string, string>()

  /**
   * @param provider the machine's provider, for messages.
   * @param machine the machine's name, its key under `machines:`.
   * @param mountType ssh, mirage, own or both.
   * @param run runs one setup command in the machine.
   * @param openPipe starts a command in the machine with its stdin and
   *   stdout held open.
   * @param working whether Mirage has work on the machine now; omitted
   *   counts it as always working.
   */
  constructor(
    private readonly provider: string,
    private readonly machine: string,
    private readonly mountType: MountType,
    private readonly run: (line: string, signal?: AbortSignal) => Promise<RunAnswer>,
    private readonly openPipe: (command: string) => Promise<MachinePipe>,
    private readonly working: () => boolean = () => true,
  ) {}

  get fileEffectsDispatched(): boolean {
    return this.mountType === 'ssh' || this.mountType === 'mirage'
  }

  /** How the host serves its prefixes: sshfs under `ssh`, mirage-fuse otherwise. */
  private get transport(): Transport {
    return this.mountType === 'ssh' ? 'ssh' : 'mirage'
  }

  /**
   * The type the machine's mount table gives a prefix the host serves:
   * macFUSE's on a Mac.
   */
  private get kind(): string {
    if (this.darwin === true) return MACFUSE_KIND
    return this.transport === 'ssh' ? 'fuse.sshfs' : 'fuse.mirage'
  }

  /** The program that mounts a prefix the host serves, for messages. */
  private get program(): string {
    return this.transport === 'ssh' ? 'sshfs' : 'mirage-fuse'
  }

  /** Whether the host serves every prefix, none being the machine's own. */
  private get servesAll(): boolean {
    return this.mountType === 'ssh' || this.mountType === 'mirage'
  }

  /**
   * Record the line for `sync`, bring the mounts in step, then refuse a line
   * that may not run: one from a cwd other than `/` that ssh serves no mount
   * for (126), one the session's restrictions reach past the dispatcher, as a
   * policy refuses it (126), one the machine cannot serve because another
   * session or another sshfs holds it, or another mount covers it (1), and
   * one over a mount of the machine's own that is gone (126). Null when the
   * line may run, which first waits out what the machine's kernel may still
   * hold of a change another made under what it is served. A refusal says
   * why on `errors`.
   */
  async validate(
    binding: WorkspaceBinding | null,
    cwd: string,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult | null> {
    const refuse = async (said: string, exitCode: number): Promise<RunResult> => {
      await errors(new TextEncoder().encode(said))
      return { exitCode }
    }
    const files = binding?.files ?? null
    const getSession = binding?.getSession ?? null
    const mountPrefixes = binding?.mountPrefixes ?? null
    if (binding === null || files === null || getSession === null || mountPrefixes === null) {
      throw new Error(`${this.provider}: mountType needs the machine in a workspace`)
    }
    const { stop, writeHeld } = currentCaller()
    this.lines.push({ stop, writeHeld, lent: new Set() })
    const begun = binding.changes?.now() ?? 0
    const seen = rstripSlash(cwd)
    const local = binding.machinePrefixes(this.machine)
    if (
      this.servesAll &&
      seen !== '' &&
      ![...servedPrefixes(mountPrefixes(), local), ...local]
        .map((p) => rstripSlash(p))
        .some((p) => seen === p || seen.startsWith(`${p}/`))
    )
      return refuse(
        `${this.provider}: the machine cannot see the working directory ${seen}; cd into a mount first\n`,
        CANNOT_EXECUTE_STATUS,
      )
    const current = getCurrentSession()
    const rules = current?.commands
    if (
      rules != null &&
      ruleTable(rules).some((rule) => (rule.paths?.length ?? 0) > 0 || rule.mount)
    )
      return refusedRun(
        this.provider,
        'this file transport cannot enforce program-specific path rules',
        errors,
      )
    if (current === null) {
      throw new Error(
        `${this.provider}: mountType serves a session's view, and this line runs as none`,
      )
    }
    const refusal = await this.locked(async () => {
      const id = binding.processes?.workspaceId ?? ''
      if (this.served.size === 0) this.name = id === '' ? this.random : sourceName(id, this.machine)
      const served = this.session
      const session = getSession(current.sessionId)
      if (served !== null && served !== session) {
        const earlier = served.sessionId === current.sessionId ? 'an earlier ' : ''
        return refuse(
          `${this.provider}: this machine shows ${earlier}session ${served.sessionId}'s view ` +
            `of the workspace; give session ${current.sessionId} a machine of its own\n`,
          1,
        )
      }
      const own = new Set(local.map((p) => rstripSlash(p)))
      const every = new Set([...mountPaths(mountPrefixes())].filter((p) => !own.has(p)))
      const ruled = new Set(
        restrictedMountsFor(current, mountPrefixes()).map((prefix) => rstripSlash(prefix) || '/'),
      )
      const refused = await this.reconcile(binding, files, session, every, ruled, signal)
      if (refused !== null) return refuse(`${this.provider}: ${refused}\n`, 1)
      const lost = this.lost()
      if (lost !== null) return refuse(`${unmounted(this.provider, lost)}\n`, CANNOT_EXECUTE_STATUS)
      const unserved = this.unserved(ruled)
      if (this.mountType !== 'own' && (!unserved || this.served.size > 0)) {
        this.session = session
      }
      return unserved
        ? refusedRun(
            this.provider,
            'a mount this session restricts is not served through the dispatcher',
            errors,
          )
        : null
    })
    const changes = binding.changes
    if (refusal !== null || this.served.size === 0 || changes === null) return refusal
    if (this.transport === 'mirage') {
      const served = [...this.served]
      const confirmed = await abortable(
        Promise.all(served.map(([, { server }]) => server.begin?.() ?? Promise.resolve(true))),
        signal,
      )
      const late = served.find((_, i) => confirmed[i] === false)?.[0]
      if (late !== undefined) {
        return refuse(`${unconfirmed(this.provider, late)}\n`, CANNOT_EXECUTE_STATUS)
      }
      return null
    }
    this.since = new Map(
      [...this.served.values()].map(({ source }) => [source, this.since.get(source) ?? begun]),
    )
    await changes.waitOut(
      new Map(
        [...this.served].map(([prefix, { source }]) => [prefix, this.since.get(source) ?? begun]),
      ),
      this.machine,
      signal,
    )
    return null
  }

  /**
   * `argv` under `MOUNT_GUARD`, holding every mount the machine had at the
   * line's admit; unchanged when it had none. `missing` holds the words a
   * program the machine cannot run is reported in (`PROGRAM_CHECK`).
   */
  guarded(
    argv: readonly string[],
    missing: readonly [string, string, string] = ['', 'command not found', ''],
  ): readonly string[] {
    const held = new Map<string, [string, string]>(
      [...this.served].map(([p, entry]) => [p, [entry.source, this.kind]]),
    )
    for (const [p, entry] of this.own) held.set(p, entry)
    if (held.size === 0) return argv
    if (this.darwin === true) {
      const marks = [...held]
        .sort(([a], [b]) => compareCodePoints(a, b))
        .flatMap(([prefix, [source, kind]]) => [
          this.points.get(prefix) ?? prefix,
          source,
          kind,
          unmounted(this.provider, prefix),
        ])
      return [
        '/bin/sh',
        '-c',
        DARWIN_MOUNT_GUARD,
        'sh',
        ...missing,
        'mount',
        ...marks,
        '--',
        ...argv,
      ]
    }
    const words = [...held]
      .sort(([a], [b]) => compareCodePoints(a, b))
      .flatMap(([prefix, [source, kind]]) => [
        mountField(prefix),
        mountField(source, true),
        kind,
        unmounted(this.provider, prefix),
      ])
    return ['/bin/sh', '-c', MOUNT_GUARD, 'sh', ...missing, '/proc/mounts', ...words, '--', ...argv]
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
    for (const kill of this.kills) kill.abort()
    this.kills.clear()
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
   * before they land, and the program never hears of one that fails. This
   * lands every one, outside the line as that close would, and
   * `fileEffectsDispatched` holds. Each landing keeps the line's write
   * admission alone: a capture waiting for the line lets it through rather
   * than waiting on it. Failures it cannot hand back, the landing stopped
   * part way or its run gone, are logged.
   *
   * @param signal the run's, which stops waiting for the landing.
   * @returns one line per write that failed to land, naming its path and
   *   why.
   */
  async land(signal?: AbortSignal): Promise<string[]> {
    const { stop, writeHeld } = currentCaller()
    const lost: string[] = []
    try {
      for (const { server } of [...this.served.values()]) {
        const failed = await runDetached(() =>
          SERVED_BY.run(this.machine, () =>
            bindCaller({ ...currentCaller(), stop, writeHeld }, () => server.sync()),
          ),
        )
        for (const [path, err] of failed) lost.push(`${this.provider}: ${path}: ${strerrorOf(err)}`)
      }
    } catch (error) {
      // The line hears of none of these, and no landing reports them again.
      for (const said of lost) console.warn(said)
      throw error
    }
    // A run its deadline stopped no longer waits for these.
    if (signal?.aborted === true) for (const said of lost) console.warn(said)
    return lost
  }

  /**
   * Land as `land` does as the line ends, however it ended. Then the line
   * lends its admission to no more requests, and waits out the ones it lent
   * it to, so a capture never reads past one still running.
   *
   * @returns one line per write that failed to land, naming its path and
   *   why.
   */
  async sync(): Promise<string[]> {
    const { stop } = currentCaller()
    try {
      return await this.land()
    } finally {
      const index = this.lines.findIndex((held) => held.stop === stop)
      const [line] = index >= 0 ? this.lines.splice(index, 1) : []
      if (line !== undefined) await Promise.all(line.lent)
    }
  }

  /**
   * Run one served request with the write admission of the latest line
   * running in the machine, from its `validate` to its `sync`, and none
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
      await bindCaller({ ...currentCaller(), stop: line.stop, writeHeld: line.writeHeld }, op)
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
   * Those of `prefixes` sshfs can mount: directories. A file mounted at a
   * path of its own, such as a `VFS.md`, stays off the machine.
   */
  private async mountable(files: Files, prefixes: string[]): Promise<string[]> {
    for (const prefix of [...this.directories.keys()]) {
      if (!prefixes.includes(prefix)) this.directories.delete(prefix)
    }
    const reader = readerOf(files)
    const out: string[] = []
    for (const prefix of prefixes) {
      const row = reader.owner(prefix)
      let known = this.directories.get(prefix)
      if (known?.row !== row) {
        known = { row, directory: await this.isDirectory(files, prefix) }
        this.directories.set(prefix, known)
      }
      if (known.directory) out.push(prefix)
    }
    return out
  }

  /**
   * Whether `prefix` is a directory. A stat that fails, such as a disk
   * mount whose folder is gone, counts as one: the prefix is served as
   * before, and the machine's own mount or the serve answers for it.
   */
  private async isDirectory(files: Files, prefix: string): Promise<boolean> {
    try {
      return (await files.stat(prefix)).type === FileType.DIRECTORY
    } catch (error) {
      logger.debug?.(`${this.provider}: could not stat ${prefix}: ${String(error)}`)
      return true
    }
  }

  /**
   * Serve what the session sees and drop what it no longer does. Returns
   * why the line may not run, a prefix another sshfs still serves or another
   * mount covers, which is left alone and nothing new served, or null once
   * in step, or with a mount of the machine's own gone, which `validate`
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
    const local = binding.machinePrefixes(this.machine).map((p) => rstripSlash(p))
    const served = servedPrefixes(binding.resolver.prefixes(), local)
    const visible = this.mountType === 'own' ? [] : await this.mountable(files, served)
    const seen = JSON.stringify([[...every].sort(compareCodePoints), visible])
    const ended = [...this.served].filter(([, entry]) => entry.ended).map(([prefix]) => prefix)
    if (this.seen === seen && ended.length === 0 && (this.servesAll || ruled.size === 0)) {
      return null
    }
    this.seen = null
    for (const p of [...every, ...served, ...this.served.keys()]) this.looked.add(p)
    const present = await this.table(signal)
    for (const p of this.served.keys()) if (!ended.includes(p) && !present.has(p)) ended.push(p)
    const own = [...every]
      .filter(
        (p) =>
          !this.servesAll &&
          present.has(p) &&
          !this.served.has(p) &&
          !(
            SERVED_KINDS.has(present.get(p)?.[1] ?? '') &&
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
        (entry[0] !== this.served.get(p)?.source || entry[1] !== this.kind) &&
        (!ended.includes(p) || entry[1] !== this.kind) &&
        !(ended.includes(p) && JSON.stringify(entry) === this.under.get(p))
      )
    })
    if (covered !== undefined) {
      return `another mount covers ${covered} in this machine; the line did not run`
    }
    for (const prefix of wanted) {
      const under = [...own, ...local].find((o) => o.startsWith(prefix + '/'))
      if (under !== undefined) {
        throw new Error(
          `${this.provider}: the machine mounts ${under} itself, and serving ${prefix} would cover it`,
        )
      }
    }
    for (const prefix of [...this.served.keys()]) {
      if (!wanted.includes(prefix) || ended.includes(prefix)) await this.drop(prefix, present)
    }
    const fresh = wanted.filter((p) => !this.served.has(p))
    for (const prefix of fresh) {
      if (await this.held(prefix, present, signal)) {
        return `another ${SERVED_KINDS.get(present.get(prefix)?.[1] ?? '') ?? ''} serves ${prefix} in this machine; give this workspace a machine of its own`
      }
    }
    if (fresh.length > 0) {
      const ssh = this.transport === 'ssh'
      if (ssh && this.darwin === true) {
        throw new Error(
          `${this.provider}: mount_type ssh needs a Linux machine; a Mac takes mount_type mirage`,
        )
      }
      const make = pipeServers.get(this.transport)
      if (make === undefined) throw new Error(ssh ? PIPE_SERVER_HINT : FSPROTO_SERVER_HINT)
      if ((await this.run(ssh ? SSHFS_LINE : MIRAGE_FUSE_LINE, signal)).exitCode !== 0) {
        throw new Error(`${this.provider}: ${ssh ? SSHFS_HINT : MIRAGE_FUSE_HINT}`)
      }
      const folder = await this.folder(served, signal)
      try {
        for (const prefix of fresh) {
          await this.serve(
            make(files, session, (op) => this.lend(op), {
              prefix,
              machine: this.machine,
              changes: binding.changes ?? null,
              watched: binding.watched,
            }),
            prefix,
            present,
            folder,
            signal,
          )
        }
      } catch (err) {
        await this.unmount()
        throw err
      }
    }
    if (this.mountType !== 'own' || topPrefixes(every).every((p) => own.includes(p))) {
      this.seen = seen
    }
    return null
  }

  /** Whether `source`, mounted at `prefix`, is a mount this workspace served: exactly `<name>-<instance>-<n>:<prefix>`. */
  private ours(source: string, prefix: string): boolean {
    const serve = source.slice(this.name.length + 1, source.length - prefix.length - 1)
    return /^[0-9a-f]{8}-[0-9]+$/.test(serve) && source === `${this.name}-${serve}:${prefix}`
  }

  /**
   * A mount of the machine's own it held and no longer does; the prefixes
   * held are kept only while the workspace mounts them.
   */
  private lost(): string | null {
    return [...this.owned].sort(compareCodePoints).find((p) => !this.own.has(p)) ?? null
  }

  /**
   * Whether another workspace's sshfs or mirage-fuse still serves `prefix`. A
   * Mac's macFUSE mount no workspace made is taken as served, as no program
   * can be told for its server.
   */
  private async held(
    prefix: string,
    present: ReadonlyMap<string, [string, string]>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const [source, kind] = present.get(prefix) ?? ['', '']
    if (!SERVED_KINDS.has(kind) || this.ours(source, prefix)) return false
    if (kind === MACFUSE_KIND && !mirageSource(source, prefix)) return true
    const found = await this.run(
      this.darwin === true ? darwinRunningLine(source) : runningLine(source),
      signal,
    )
    if (found.exitCode !== 0 && found.exitCode !== 1) {
      throw new Error(
        `${this.provider}: cannot tell whether ${source} is served: ${said(found.stderr)}`,
      )
    }
    return found.exitCode === 0
  }

  /**
   * Mirage's folder on the machine (`machineDirLine`), where each sshfs keeps
   * its log: resolved once, so every look at a log finds the one sshfs wrote.
   * Mirrors Python's `MachineMounts._folder`.
   *
   * @param prefixes the workspace prefixes the machine has at the same paths.
   * @param signal stops the line.
   */
  private async folder(prefixes: readonly string[], signal?: AbortSignal): Promise<string> {
    const found = await this.run(machineDirLine(prefixes) + 'printf %s "$d"', signal)
    const folder = said(found.stdout)
    if (found.exitCode !== 0 || !folder) throw new Error(`${this.provider}: ${said(found.stderr)}`)
    return folder
  }

  private async serve(
    server: PipeServer,
    prefix: string,
    present: ReadonlyMap<string, [string, string]>,
    folder: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.under.set(prefix, JSON.stringify(present.get(prefix) ?? null))
    const [old, kind] = present.get(prefix) ?? ['', '']
    if (SERVED_KINDS.has(kind) && this.ours(old, prefix) && !this.sources.has(old))
      await this.reclaim(old, prefix, signal)
    else if (SERVED_KINDS.has(kind)) await this.run(this.unmountLine(prefix), signal)
    const point = await this.mountpoint(prefix, folder, signal)
    const logPath = `${folder}/${this.program}-${crypto.randomUUID().replaceAll('-', '')}.log`
    const log = singleQuote(logPath)
    this.serves += 1
    const source = `${this.name}-${this.instance}-${String(this.serves)}:${prefix}`
    this.sources.add(source)
    const pipe = await this.openPipe(
      this.transport === 'ssh'
        ? sshfsLine(source, point, logPath)
        : mirageFuseLine(source, point, logPath),
    )
    const entry: Served = {
      source,
      pipe,
      server,
      serving: Promise.resolve(),
      ended: false,
      failure: null,
    }
    entry.serving = Promise.resolve(
      runDetached(() => SERVED_BY.run(this.machine, () => server.serve(pipe.reader, pipe.writer))),
    ).then(
      () => {
        this.ended(prefix, entry)
      },
      (err: unknown) => {
        entry.failure = err instanceof Error ? err : new Error(String(err))
        this.ended(prefix, entry)
      },
    )
    this.served.set(prefix, entry)
    try {
      const deadline = Date.now() + MOUNT_WAIT_SECONDS * 1000
      for (;;) {
        try {
          const [found, kind] = (await this.table(signal)).get(prefix) ?? ['', '']
          if (!entry.ended && found === source && kind === this.kind) return
        } catch (error) {
          signal?.throwIfAborted()
          const diagnostic = (await pipe.diagnostic?.()) ?? ''
          if (diagnostic) {
            const said = error instanceof Error ? error.message : String(error)
            throw new Error(
              `${this.provider}: ${this.program} did not mount ${prefix}: ${said}; helper said: ${diagnostic}`,
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
            console.debug(`${this.provider}: reading the ${this.program} log failed`, error)
            if (!reason) reason = `cannot read the ${this.program} log: ${String(error)}`
          }
          reason ||= `no word from ${this.program}`
          if (entry.failure !== null) reason += `; the file server failed: ${entry.failure.message}`
          throw new Error(`${this.provider}: ${this.program} did not mount ${prefix}: ${reason}`)
        }
        signal?.throwIfAborted()
        await sleep(MOUNT_POLL_SECONDS * 1000)
      }
    } finally {
      if (signal?.aborted !== true) await this.dropLog(log)
    }
  }

  /**
   * Kill the sshfs of a prefix whose server ended, unless a line dropped it
   * already: a program blocked on the mount then gets an error rather than
   * hanging. With no work on the machine no program of Mirage's is blocked,
   * and the server most likely ended as the machine paused itself, so the
   * sshfs is left for the next line. The next line unmounts it and serves
   * the prefix again, as for any server that ended; a kill that lands late, even after a restart,
   * reaches only this serve's sshfs, never the one serving the prefix again. A kill the machine does
   * not answer is let go after `UNMOUNT_WAIT_SECONDS`, or when the mounts
   * close.
   */
  private ended(prefix: string, entry: Served): void {
    entry.ended = true
    if (this.served.get(prefix) !== entry || !this.working()) return
    const kill = new AbortController()
    const signal = mergeSignals(kill.signal, AbortSignal.timeout(UNMOUNT_WAIT_SECONDS * 1000))
    this.kills.add(kill)
    abortable(this.run(this.killLine(entry.source), signal), signal)
      .then(
        (killed) => {
          if (killed.exitCode !== 0) {
            console.warn(
              `${this.provider}: killing the ${this.program} for ${prefix} failed: ${said(killed.stderr)}`,
            )
          }
        },
        (err: unknown) => {
          if (!kill.signal.aborted) {
            console.warn(`${this.provider}: killing the ${this.program} for ${prefix} failed:`, err)
          }
        },
      )
      .finally(() => {
        this.kills.delete(kill)
      })
  }

  /**
   * Kill the sshfs an earlier instance of this workspace left serving
   * `prefix`, then unmount it: unmounted alone, it stays blocked on its dead
   * pipe. The next serve may take the same source, so a failed unmount
   * fails loud rather than leaving the old mount to pass for the new one.
   */
  private async reclaim(source: string, prefix: string, signal?: AbortSignal): Promise<void> {
    await this.run(this.killLine(source), signal)
    const done = await this.run(this.unmountLine(prefix), signal)
    if (done.exitCode !== 0) {
      throw new Error(
        `${this.provider}: cannot unmount ${prefix}, which this workspace served before a restart: ${said(done.stderr)}`,
      )
    }
  }

  /**
   * Remove the helper's setup log; keeping it only costs a file.
   *
   * @param log the quoted log path in the machine.
   */
  private async dropLog(log: string): Promise<void> {
    try {
      const removed = await this.run(`rm -f -- ${log}`)
      if (removed.exitCode !== 0) console.debug('could not remove sshfs log:', said(removed.stderr))
    } catch (err) {
      console.debug('could not remove sshfs log:', err)
    }
  }

  /**
   * Make `prefix` a folder the machine can mount on and answer where its
   * mount shows: `prefix` itself, or on a Mac its real path
   * (`darwinMountpointLine`), a link into Mirage's folder for a prefix in
   * macOS's read-only root. Mirrors Python's `MachineMounts._mountpoint`.
   *
   * @param prefix the prefix to serve.
   * @param folder Mirage's folder on the machine.
   * @param signal stops the line.
   */
  private async mountpoint(prefix: string, folder: string, signal?: AbortSignal): Promise<string> {
    if (this.darwin === true) {
      const root = `${folder}/mnt`
      const made = await this.run(darwinMountpointLine(prefix, root), signal)
      if (made.exitCode === DARWIN_ADMIN_STATUS) {
        throw new Error(darwinAdminHint(this.provider, prefix, root))
      }
      const out = made.stdout === null ? '' : DECODER.decode(made.stdout).replace(/\n$/, '')
      const point = out.slice(out.lastIndexOf('\n') + 1)
      if (made.exitCode !== 0 || !point) {
        throw new Error(
          `${this.provider}: cannot make ${prefix} in the machine: ${said(made.stderr)}`,
        )
      }
      this.points.set(prefix, point)
      return point
    }
    const path = singleQuote(prefix)
    const made = await this.run(
      `mkdir -p ${path} 2>/dev/null || { sudo -n mkdir -p ${path} && ` +
        `sudo -n chown "$(id -u):$(id -g)" ${path}; }`,
      signal,
    )
    if (made.exitCode !== 0) {
      throw new Error(
        `${this.provider}: cannot make ${prefix} in the machine: ${said(made.stderr)}`,
      )
    }
    return prefix
  }

  /** The command that unmounts `prefix`, at its real path on a Mac. */
  private unmountLine(prefix: string): string {
    if (this.darwin === true) return darwinUnmountLine(this.points.get(prefix) ?? prefix)
    return unmountLine(prefix)
  }

  /** The command that kills what serves `source`. */
  private killLine(source: string): string {
    return this.darwin === true ? darwinKillLine(source) : killLine(source)
  }

  private async table(signal?: AbortSignal): Promise<Map<string, [string, string]>> {
    if (this.darwin === null) {
      const asked = await this.run('uname -s', signal)
      if (asked.exitCode !== 0) {
        throw new Error(
          `${this.provider}: cannot ask the machine its system: ${said(asked.stderr)}`,
        )
      }
      this.darwin = said(asked.stdout) === 'Darwin'
    }
    if (this.darwin) {
      const listed = await this.run(
        darwinTableLine(
          [...this.looked].filter((prefix) => !this.points.has(prefix)).sort(compareCodePoints),
        ),
        signal,
      )
      if (listed.exitCode !== 0) {
        throw new Error(
          `${this.provider}: cannot read the machine's mount table: ${said(listed.stderr)}`,
        )
      }
      const [rows, points] = darwinMountTable(DECODER.decode(listed.stdout), this.points)
      for (const [prefix, point] of points) this.points.set(prefix, point)
      return rows
    }
    const listed = await this.run('cat /proc/mounts', signal)
    if (listed.exitCode !== 0) {
      throw new Error(
        `${this.provider}: cannot read the machine's mount table: ${said(listed.stderr)}`,
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
    if (present.get(prefix)?.[0] === entry.source) {
      try {
        const done = await this.run(this.unmountLine(prefix))
        if (done.exitCode !== 0) {
          console.warn(
            `${this.provider}: unmounting ${prefix} in the machine failed: ${said(done.stderr)}`,
          )
        }
      } catch (err) {
        console.warn(`${this.provider}: unmounting ${prefix} in the machine failed:`, err)
      }
    }
    try {
      await entry.pipe.stop()
      await within(entry.serving, UNMOUNT_WAIT_SECONDS * 1000)
      if (entry.failure !== null) throw entry.failure
    } catch (err) {
      console.warn(`${this.provider}: ending the file server for ${prefix} failed:`, err)
    }
  }

  private async unmount(): Promise<void> {
    let present = new Map<string, [string, string]>()
    if (this.served.size > 0) {
      try {
        present = await this.table()
      } catch (err) {
        console.warn(
          `${this.provider}: reading the mount table to unmount failed; unmounting every served prefix:`,
          err,
        )
        present = new Map([...this.served].map(([p, entry]) => [p, [entry.source, this.kind]]))
      }
    }
    for (const prefix of [...this.served.keys()]) await this.drop(prefix, present)
    this.seen = null
  }
}
