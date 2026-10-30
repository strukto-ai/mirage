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

import { resolve } from 'node:path'
import {
  networkRule,
  type NetworkRule,
  type NetworkSetting,
} from '@struktoai/mirage-core/io/network'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { Policies } from '@struktoai/mirage-core/policy/policies'
import { ScriptPolicy } from '@struktoai/mirage-core/policy/script'
import {
  Outcome,
  type Deny,
  type Explanation,
  type ProfileScripts,
  type WorkspaceContext,
} from '@struktoai/mirage-core/policy/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
import { WorkspaceRunner } from '@struktoai/mirage-core/workspace/runner'
import { loadPolicyFile, type DiskRecordClient, type Workspace } from '@struktoai/mirage-node'
import { watchNetwork } from '@struktoai/mirage-node/io/network'
import { DaemonConfigError, readDaemonTable } from './daemon_config.ts'
import {
  ENV_GRACEFUL_TIMEOUT,
  ENV_MAX_SESSIONS,
  ENV_MAX_WORKSPACES,
  ENV_POLICY_FILE,
} from './env.ts'
import { ExecutionTable } from './jobs.ts'
import { mirageHome } from './paths.ts'

// Under the daemon's state root: one record per workspace id naming the
// account that owns it.
export const OWNERS_PREFIX = 'owners'

/**
 * One registered workspace. `owner` is the account that created it; null
 * when it was created by a caller with no account.
 */
/** What a create's claim on an id found. */
export enum Claim {
  New = 'new',
  Held = 'held',
  Taken = 'taken',
}

export class WorkspaceEntry {
  readonly id: string
  readonly runner: WorkspaceRunner
  readonly owner: string | null
  readonly createdAt: number
  /** The fingerprint of the config it was created from, when it was. */
  configDigest: string | null = null
  acceptingJobs = true
  /**
   * The server's policy file's programs, as this workspace runs them;
   * null when the file names none past preWorkspace.
   */
  programs: ScriptPolicy | null = null

  constructor(id: string, runner: WorkspaceRunner, owner: string | null = null) {
    this.id = id
    this.runner = runner
    this.owner = owner
    this.createdAt = Date.now() / 1000
  }
}

export interface WorkspaceRegistryOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
  /**
   * Refuse callers with no account (jwt mode); otherwise such a caller
   * may use every workspace.
   */
  accountsRequired?: boolean
  /**
   * Where each workspace id's owning account is kept across restarts, so
   * a stored workspace is only ever reopened by its owner. Absent keeps
   * ownership in memory.
   */
  owners?: DiskRecordClient
  /** The most workspaces held at once, those being built among them; null for no cap. */
  maxWorkspaces?: number | null
  /**
   * The server's own policies, which answer `preWorkspace` and are
   * registered on every workspace it builds, after the workspace's own.
   */
  policies?: readonly Policy[]
  /** The server's policy programs, by method, which answer the same way. */
  programs?: ProfileScripts
  /** The most sessions each workspace holds, its default among them; null for no cap. */
  maxSessions?: number | null
}

/**
 * The most workspaces the server holds at once: `maxWorkspaces` when given,
 * else `$MIRAGE_MAX_WORKSPACES`, else the `max_workspaces` key in
 * config.toml's `[daemon]` table, else no cap. Mirrors Python's
 * `resolve_max_workspaces`.
 */
export function resolveMaxWorkspaces(
  maxWorkspaces?: number | null,
  env: Record<string, string | undefined> = process.env,
): number | null {
  return cap(maxWorkspaces, env, ENV_MAX_WORKSPACES, 'max_workspaces')
}

/**
 * The most sessions each workspace holds, its default session among them:
 * `maxSessions` when given, else `$MIRAGE_MAX_SESSIONS`, else the
 * `max_sessions` key in config.toml's `[daemon]` table, else no cap.
 * Mirrors Python's `resolve_max_sessions`.
 */
export function resolveMaxSessions(
  maxSessions?: number | null,
  env: Record<string, string | undefined> = process.env,
): number | null {
  return cap(maxSessions, env, ENV_MAX_SESSIONS, 'max_sessions')
}

/**
 * A positive whole cap: `given`, else the `name` variable, else `key` in
 * config.toml's `[daemon]` table, else null for no cap. Throws
 * DaemonConfigError for anything but a positive whole number.
 */
function cap(
  given: number | null | undefined,
  env: Record<string, string | undefined>,
  name: string,
  key: string,
): number | null {
  let value: string | number | undefined = given ?? undefined
  if (value === undefined) {
    const fromEnv = env[name]
    value =
      fromEnv !== undefined && fromEnv !== '' ? fromEnv : readDaemonTable(mirageHome(env))[key]
    if (value === undefined || value === '') return null
  }
  const held = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : 0
  if (!Number.isSafeInteger(held) || held < 1) {
    throw new DaemonConfigError(
      `${key} must be a positive whole number, got ${JSON.stringify(value)}`,
    )
  }
  return held
}

/**
 * How long a shutdown lets running lines finish before it cancels them:
 * `gracefulTimeout` when given, else `$MIRAGE_GRACEFUL_TIMEOUT`, else the
 * `graceful_timeout` key in config.toml's `[daemon]` table, else 0. Mirrors
 * Python's `resolve_graceful_timeout`.
 */
export function resolveGracefulTimeout(
  gracefulTimeout?: number | null,
  env: Record<string, string | undefined> = process.env,
): number {
  let value: string | number | undefined = gracefulTimeout ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_GRACEFUL_TIMEOUT]
    value =
      fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : readDaemonTable(mirageHome(env)).graceful_timeout
    if (value === undefined || value === '') return 0
  }
  const seconds = typeof value === 'number' ? value : value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new DaemonConfigError(
      `graceful_timeout must be a number of seconds, 0 or more, got ${JSON.stringify(value)}`,
    )
  }
  return seconds
}

/**
 * The server's policy programs: those of `policyFile` when given, else of
 * `$MIRAGE_POLICY_FILE`, else of the `policy_file` key in config.toml's
 * `[daemon]` table, read next to it, else none. Mirrors Python's
 * `resolve_policy_file`.
 */
export function resolvePolicyFile(
  policyFile?: string,
  env: Record<string, string | undefined> = process.env,
): ProfileScripts {
  let path = policyFile ?? env[ENV_POLICY_FILE]
  if (path === undefined || path === '') {
    const named = readDaemonTable(mirageHome(env)).policy_file
    if (named === undefined || named === '') return {}
    path = resolve(mirageHome(env), named)
  }
  return loadPolicyFile(path)
}

/** The server's policy programs, which every session answers to. */
class Programs {
  constructor(private readonly programs: ProfileScripts) {}

  scriptsOf(): ProfileScripts {
    return this.programs
  }
}

export class WorkspaceRegistry {
  readonly jobs = new ExecutionTable()
  private entries = new Map<string, WorkspaceEntry>()
  private readonly removals = new Map<string, Promise<WorkspaceEntry>>()
  private readonly creates = new Map<string, { digest: string; done: Promise<unknown> }>()
  private readonly idleGraceSeconds: number
  private readonly onIdleExit: (() => void) | null
  private idleTimer: NodeJS.Timeout | null = null
  accountsRequired: boolean
  private readonly owners: DiskRecordClient | null
  readonly maxWorkspaces: number | null
  readonly maxSessions: number | null
  readonly policies: readonly Policy[]
  private readonly programs: ProfileScripts
  private readonly admissionPrograms: ScriptPolicy
  private readonly admission: Policies

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.maxWorkspaces = options.maxWorkspaces ?? null
    this.maxSessions = options.maxSessions ?? null
    this.policies = [...(options.policies ?? [])]
    this.programs = Object.fromEntries(
      Object.entries(options.programs ?? {}).filter(([method]) => method !== 'preWorkspace'),
    )
    this.admissionPrograms = new ScriptPolicy(new Programs(options.programs ?? {}))
    this.admission = new Policies([...this.policies, this.admissionPrograms])
    this.idleGraceSeconds = options.idleGraceSeconds ?? 30
    this.onIdleExit = options.onIdleExit ?? null
    this.accountsRequired = options.accountsRequired ?? false
    this.owners = options.owners ?? null
  }

  /**
   * The rule a workspace with this `network` is held to here: its own
   * setting, with the cloud metadata addresses refused in jwt mode
   * (`accountsRequired`); null when nothing limits it. Throws when the
   * setting or one of its entries is not valid.
   */
  ruleFor(setting: NetworkSetting = true): NetworkRule | null {
    const rule = networkRule(setting, this.accountsRequired)
    if (rule !== null) watchNetwork()
    return rule
  }

  /**
   * The server's refusal of a workspace about to be built, null when its
   * policies let it. `config` is the config as the caller wrote it: a
   * create's whole config, a clone's or a load's override.
   */
  async refusal(config: Record<string, JsonValue>, account: string | null): Promise<Deny | null> {
    return this.admission.preWorkspace(workspaceContext(config, account))
  }

  /**
   * What the server's policies say of a workspace about to be built, every
   * answer included, without building it.
   */
  async explanation(
    config: Record<string, JsonValue>,
    account: string | null,
  ): Promise<Explanation> {
    const answers = await this.admission.answers('preWorkspace', workspaceContext(config, account))
    const deny = answers.find((answer) => answer.kind === 'deny')
    return {
      outcome: deny === undefined ? Outcome.ALLOW : Outcome.DENY,
      reason: deny?.reason ?? '',
      source: '',
      answers,
      refusal: null,
    }
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Whether a workspace being built fits under `maxWorkspaces`, counting
   * those registered and every build in flight, its own among them, so
   * builds racing each other cannot pass it. A build that registered and
   * still answers its request counts once. `own` false asks whether one
   * more would fit, as readiness does. Mirrors Python's `has_room`.
   */
  hasRoom(own = true): boolean {
    if (this.maxWorkspaces === null) return true
    const ids = new Set([...this.entries.keys(), ...this.creates.keys()])
    return ids.size + (own ? 0 : 1) <= this.maxWorkspaces
  }

  /**
   * Whether the server is shutting down: no workspace is built and no line
   * starts after it, and readiness answers that it is going. The flag lives
   * on the job table, which every door that starts a line holds.
   */
  get draining(): boolean {
    return this.jobs.draining
  }

  set draining(value: boolean) {
    this.jobs.draining = value
  }

  /**
   * Stop building workspaces and let running lines end. Each workspace
   * holds new lines while its running ones finish, up to `seconds`; the
   * lines still running then are cancelled. The workspaces stay registered
   * for `closeAll` to stop. Mirrors Python's `drain`.
   */
  async drain(seconds: number): Promise<void> {
    this.draining = true
    await Promise.all([...this.entries.values()].map((entry) => settle(entry, seconds)))
  }

  /**
   * Run one create of `id` at a time. A create of the same config that
   * arrives while another is building waits for it, then finds the
   * workspace it registered, rather than building a second over its
   * state; it would stall on the same secrets and mounts anyway. A
   * create of another config is not admitted and does not wait, so a
   * stuck create never holds it: `run` gets `admitted` false.
   */
  async creating<T>(
    id: string,
    configDigest: string,
    run: (admitted: boolean) => Promise<T>,
  ): Promise<T> {
    for (
      let pending = this.creates.get(id);
      pending !== undefined;
      pending = this.creates.get(id)
    ) {
      if (pending.digest !== configDigest) return run(false)
      await Promise.allSettled([pending.done])
    }
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.creates.set(id, { digest: configDigest, done })
    try {
      return await run(true)
    } finally {
      this.creates.delete(id)
      finish()
    }
  }

  /** Whether `id` is being deleted or closed. */
  removing(id: string): boolean {
    return this.removals.has(id)
  }

  get(id: string): WorkspaceEntry {
    const e = this.entries.get(id)
    if (e === undefined) throw new Error(`workspace not found: ${id}`)
    return e
  }

  list(): WorkspaceEntry[] {
    return Array.from(this.entries.values())
  }

  size(): number {
    return this.entries.size
  }

  /**
   * The live entry `account` may use, else null. The one access rule
   * every entry point asks: a caller with no account may use every workspace
   * unless accounts are required; an account may use only the workspaces
   * it owns, so one created by a caller with no account is closed to
   * every account. A workspace that exists but belongs to another
   * account answers null like a missing one, so its id does not leak.
   */
  visible(id: string, account: string | null): WorkspaceEntry | null {
    const entry = this.entries.get(id)
    if (entry === undefined) return null
    if (account === null) return this.accountsRequired ? null : entry
    return entry.owner === account ? entry : null
  }

  /**
   * Whether `account` may reach a record `id` made at `at` (seconds):
   * the same rule as `visible`, for an id that may not be live. A closed
   * workspace's jobs, or a stored workspace after a restart, answer to
   * the owner its claim names. A live workspace answers only for records
   * made since it was created, so a workspace created again under a
   * deleted one's id never reaches what the deleted one left.
   */
  async allows(id: string, account: string | null, at: number): Promise<boolean> {
    if (account === null) return !this.accountsRequired
    if (this.entries.has(id)) {
      const entry = this.visible(id, account)
      return entry !== null && at >= entry.createdAt
    }
    if (this.owners === null) return false
    const [stored] = await this.owners.get(id)
    return stored !== null && stored.account === account
  }

  /**
   * Record `account` as the owner of `id`. The claim outlives the
   * daemon, so after a restart the stored workspace under that id reopens
   * only for the same account. A caller with no account claims nothing.
   * An id with stored state and no owner (written before accounts were
   * required) is no account's to take. `New` when this call recorded the
   * owner, `Held` when the account already owned the id (or none is
   * recorded), `Taken` when it is not the account's to create.
   */
  async claim(id: string, account: string | null, stored: boolean): Promise<Claim> {
    if (account === null || this.owners === null) return Claim.Held
    let [record] = await this.owners.get(id)
    if (record === null && !stored) {
      if (await this.owners.casPut(id, { account, generation: 1 }, 0)) return Claim.New
      ;[record] = await this.owners.get(id)
    }
    return record !== null && record.account === account ? Claim.Held : Claim.Taken
  }

  /** Drop the owner a failed create recorded, freeing the id. */
  async release(id: string): Promise<void> {
    if (this.owners !== null) await this.owners.delete([id])
  }

  /**
   * `fn` handed the server's policies, for a snapshot restore to meet as it
   * reads the snapshot's saved values, as a live write meets them. The
   * programs' runner is the restore's own, closed as it ends; `add` takes
   * the list back as `restoredWith`. Mirrors Python's `restoring`.
   */
  async restoring<T>(fn: (policies: readonly Policy[]) => Promise<T>): Promise<T> {
    const programs =
      Object.keys(this.programs).length > 0 ? new ScriptPolicy(new Programs(this.programs)) : null
    try {
      return await fn([...this.policies, ...(programs === null ? [] : [programs])])
    } finally {
      await programs?.close()
    }
  }

  /**
   * Wrap `ws` in a runner and register it. `restoredWith` is the list
   * `restoring` gave the restore that built it, taken off before the
   * server's own policies are attached.
   */
  add(
    ws: Workspace,
    id?: string,
    owner: string | null = null,
    restoredWith: readonly Policy[] = [],
  ): WorkspaceEntry {
    const wid = id ?? newWorkspaceId()
    if (this.entries.has(wid) || this.removals.has(wid))
      throw new Error(`workspace id already exists: ${wid}`)
    for (const policy of restoredWith) ws.policies.remove(policy)
    for (const policy of this.policies) ws.policies.add(policy)
    ws.registry.network = this.ruleFor(ws.network)
    // An account reaches only the workspaces it owns, so every method's
    // caller is the owner's account.
    ws.policies.account = owner
    const entry = new WorkspaceEntry(wid, new WorkspaceRunner(ws), owner)
    if (Object.keys(this.programs).length > 0) {
      entry.programs = new ScriptPolicy(new Programs(this.programs))
      ws.policies.add(entry.programs)
    }
    this.entries.set(wid, entry)
    this.cancelIdleTimer()
    return entry
  }

  /**
   * Delete `id`: stop its runner and drop its state. The workspace's
   * links, history, sessions, metadata, jobs and owner leave with it, so a
   * workspace created later under the same id starts empty, for any
   * account.
   * `closeAll` (daemon shutdown) keeps them. The id stays registered
   * until the deletion is done, so a create under it is refused rather
   * than registering a workspace whose state this deletion would then
   * remove. An overlapping remove of
   * the same id joins the deletion in flight, so it never unregisters a
   * workspace created after it.
   */
  async remove(id: string): Promise<WorkspaceEntry> {
    let removal = this.removals.get(id)
    if (removal === undefined) {
      const entry = this.entries.get(id)
      if (entry === undefined) throw new Error(`workspace not found: ${id}`)
      entry.acceptingJobs = false
      removal = this.drop(entry)
      this.removals.set(id, removal)
    }
    return removal
  }

  /** Run one deletion, releasing the id once it is done. */
  private async drop(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    try {
      await stop(entry, true)
      if (this.owners !== null) await this.owners.delete([entry.id])
    } finally {
      this.jobs.discardWorkspace(entry.id)
      this.removals.delete(entry.id)
      this.entries.delete(entry.id)
      if (this.entries.size === 0) this.startIdleTimer()
    }
    return entry
  }

  /**
   * Close `id` and keep its state. The runner stops, which cancels its
   * lines and closes its sessions; the stored sessions, links, history
   * and owner stay, so the owner creating the same id later picks them
   * up. No new request reaches the closing runner, and the id stays
   * reserved until it has stopped, so a create under it never loads state
   * the old runner is still writing.
   */
  async close(id: string): Promise<WorkspaceEntry> {
    let removal = this.removals.get(id)
    if (removal === undefined) {
      const entry = this.entries.get(id)
      if (entry === undefined) throw new Error(`workspace not found: ${id}`)
      entry.acceptingJobs = false
      this.entries.delete(id)
      removal = this.shut(entry)
      this.removals.set(id, removal)
    }
    return removal
  }

  /** Run one close, releasing the id once the runner has stopped. */
  private async shut(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    try {
      await stop(entry)
    } finally {
      this.removals.delete(entry.id)
      if (this.entries.size === 0) this.startIdleTimer()
    }
    return entry
  }

  async closeAll(): Promise<void> {
    this.cancelIdleTimer()
    const ids = Array.from(this.entries.keys())
    for (const id of ids) {
      const entry = this.entries.get(id)
      this.entries.delete(id)
      if (entry !== undefined) {
        entry.acceptingJobs = false
        await stop(entry)
      }
    }
    await this.admissionPrograms.close()
  }

  private startIdleTimer(): void {
    if (this.onIdleExit === null) return
    if (this.idleGraceSeconds <= 0) {
      this.onIdleExit()
      return
    }
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.entries.size === 0 && this.onIdleExit !== null) this.onIdleExit()
    }, this.idleGraceSeconds * 1000)
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

function workspaceContext(
  config: Record<string, JsonValue>,
  account: string | null,
): WorkspaceContext {
  return { config, caller: Object.freeze({ session: null, account }) }
}

/**
 * Stop an entry's runner, closing the runtimes its server policy programs
 * ran on before the workspace goes. Mirrors Python's `_stop`.
 */
/**
 * Let an entry's running lines end within `seconds`, holding new ones
 * meanwhile, and cancel those still running then.
 */
async function settle(entry: WorkspaceEntry, seconds: number): Promise<void> {
  const ws = entry.runner.ws
  try {
    await ws.quiesced(() => Promise.resolve(), seconds)
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EBUSY') throw err
    console.debug(`drain: cancelling ${entry.id}'s lines:`, err)
    await ws.cancel()
  }
}

async function stop(entry: WorkspaceEntry, drop = false): Promise<void> {
  if (entry.programs !== null) {
    try {
      await entry.runner.call(entry.programs.close())
    } catch (error) {
      console.error(`closing ${entry.id}'s policy programs: ${String(error)}`)
    }
  }
  await entry.runner.stop(drop ? { delete: true } : {})
}
