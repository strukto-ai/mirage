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

import { lstripSlash, rstripSlash } from '../../../utils/slash.ts'
import type { BridgeDispatchFn } from '../python/mirage_bridge.ts'
import { ScriptSource, type RouteScript } from '../route/types.ts'
import { scriptStringError, type RunArgs, type RunResult, type Runtime } from '../runtime.ts'
import { coerceConfig, type NormalizedSandboxConfig, type SandboxConfig } from './config.ts'
import { DEFAULT_WORKSPACE_ROOT, MOUNT_SPEC_ENV, SYSTEM_MOUNTS } from './constants.ts'

// Shell-quote one token, leaving already-safe path tokens bare
// (mirrors Python's shlex.quote output for the same inputs).
function shQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

/** Per-prefix remote mount specs; null = not remotely mountable. */
export type MountSpecs = Record<string, Record<string, unknown> | null>

/** Constructor options for a RemoteSandbox subclass (a yaml entry's keys). */
export interface RemoteSandboxOptions {
  /** Commands that place a whole line here; ["*"] claims every line. */
  captures?: readonly string[]
  /** Provider credential; absent reads the provider's own env variable. */
  apiKey?: string
  /** How the sandbox machine is built (a yaml entry's `config` block). */
  config?: SandboxConfig
  /** Reattach to this live sandbox instead of creating one. */
  sandboxId?: string
  /**
   * Where the workspace appears inside the sandbox. Omitted resolves
   * through defaultWorkspaceRoot() on the first line, so each
   * provider lands somewhere its sandbox user can write (Daytona:
   * $HOME/workspace). The workspace becomes visible by running mirage
   * inside the sandbox and FUSE-mounting each remotable mount (S3
   * today) live, so reads and writes flow both ways with no sync. This
   * needs an image or snapshot with fuse3 and mirage-ai[s3,fuse]
   * installed.
   */
  workspaceRoot?: string
  /** Per-line admission script, the same contract as any runtime. */
  script?: RouteScript
}

/**
 * A runtime that runs whole lines inside a remote sandbox.
 *
 * Subclasses adapt one provider by implementing the hooks
 * (createSandbox, execLine, upload, download, close); everything else
 * is inherited: routing and captures, per-line scripts, lazy
 * provisioning on the first line, workspace mounting, and reattach to
 * a live sandbox by id. The sandbox is created on the first line,
 * never at workspace construction.
 */
export abstract class RemoteSandbox implements Runtime {
  abstract readonly name: string
  readonly runsLines = true
  readonly captures: readonly string[]
  readonly apiKey: string | undefined
  readonly config: NormalizedSandboxConfig
  workspaceRoot: string | null
  script?: RouteScript
  private sandboxIdValue: string | null
  // True only when this runtime created the sandbox itself: close()
  // must delete only what it created, so reattaching by sandboxId
  // never destroys a sandbox someone else owns.
  ownedSandbox = false
  private starting: Promise<void> | null = null
  private dispatch: BridgeDispatchFn | null = null
  private mountPrefixes: (() => string[]) | null = null
  private mountSpecs: (() => MountSpecs) | null = null

  constructor(options: RemoteSandboxOptions | Record<string, unknown> = {}) {
    const opts = options as RemoteSandboxOptions
    if (typeof opts.script === 'string') throw scriptStringError()
    this.captures = opts.captures !== undefined ? opts.captures.slice() : ['*']
    this.apiKey = opts.apiKey
    this.config = coerceConfig(opts.config)
    this.workspaceRoot = opts.workspaceRoot ?? null
    if (typeof opts.script === 'function' || opts.script instanceof ScriptSource) {
      this.script = opts.script
    }
    this.sandboxIdValue = opts.sandboxId ?? null
  }

  /** The live sandbox id, null before the first line runs. */
  get sandboxId(): string | null {
    return this.sandboxIdValue
  }

  attach(
    dispatch: BridgeDispatchFn,
    listMounts: () => string[],
    listMountSpecs?: () => MountSpecs,
  ): void {
    this.dispatch = dispatch
    this.mountPrefixes = listMounts
    this.mountSpecs = listMountSpecs ?? null
  }

  run(_args: RunArgs): Promise<RunResult> {
    return Promise.reject(
      new Error(
        `runtime '${this.name}' runs whole lines in a remote sandbox, ` +
          `not single interpreter stages`,
      ),
    )
  }

  /**
   * Run one raw line in the sandbox, provisioning it lazily.
   *
   * The first line creates the sandbox (or reattaches when a sandboxId
   * was given) and mounts the workspace; every line then executes with
   * the session environment merged over the sandbox environment and
   * the cwd resolved under workspaceRoot.
   *
   * The line itself runs verbatim: mounts appear at
   * `<workspaceRoot>/<prefix>`, so paths relative to the session cwd
   * resolve for free, and absolute paths are the caller's
   * responsibility (mirage does not rewrite them).
   */
  async runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    await this.ensureStarted()
    const merged = { ...this.config.env, ...env }
    return this.execLine(line, stdin, merged, this.sandboxCwd(cwd))
  }

  // Single-flight provisioning: concurrent first lines share one start,
  // and a failed start clears the slot so the next line retries.
  private ensureStarted(): Promise<void> {
    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = null
      throw err
    })
    return this.starting
  }

  private async start(): Promise<void> {
    if (this.sandboxIdValue === null) {
      this.sandboxIdValue = await this.createSandbox()
      this.ownedSandbox = true
    } else {
      await this.connectSandbox(this.sandboxIdValue)
    }
    this.workspaceRoot ??= await this.defaultWorkspaceRoot()
    await this.mountWorkspace()
  }

  /**
   * The workspaceRoot when none was given, provider-resolved.
   *
   * Called once, after the sandbox is live and before the workspace
   * mounts, so adapters can ask the sandbox itself (e.g. $HOME) for a
   * directory its user can write.
   */
  defaultWorkspaceRoot(): Promise<string> {
    return Promise.resolve(DEFAULT_WORKSPACE_ROOT)
  }

  /** The session cwd as a path inside the sandbox. */
  sandboxCwd(cwd: string): string {
    const root = this.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    const rel = lstripSlash(cwd)
    if (rel === '') return root
    return `${rstripSlash(root)}/${rel}`
  }

  private userMountPrefixes(): string[] {
    const prefixes = new Set<string>()
    for (const raw of this.mountPrefixes?.() ?? []) {
      const prefix = rstripSlash(raw)
      prefixes.add(prefix === '' ? '/' : prefix)
    }
    for (const system of SYSTEM_MOUNTS) prefixes.delete(system)
    // A bare "/" next to real mounts is the synthetic default root,
    // not a user mount; walk it only when it is the whole world.
    if (prefixes.size > 1) prefixes.delete('/')
    return [...prefixes].sort()
  }

  /**
   * The workspace's user mounts as [spec, sandbox mountpoint].
   *
   * System mounts (/dev, the history view) are excluded: the sandbox
   * has its own, and they are host machinery, not user data. A user
   * mount with no spec fails loud.
   */
  private desiredMounts(): Record<string, [Record<string, unknown>, string]> {
    const specs = this.mountSpecs?.() ?? {}
    const root = rstripSlash(this.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT)
    const desired: Record<string, [Record<string, unknown>, string]> = {}
    for (const prefix of this.userMountPrefixes()) {
      const spec = specs[prefix] ?? null
      if (spec === null) {
        throw new Error(
          `mount '${prefix}' is not remotely mountable; sandbox runtimes ` +
            `FUSE-mount remote-backed mounts`,
        )
      }
      const mountpoint = prefix === '/' ? root : `${root}/${lstripSlash(prefix)}`
      desired[prefix] = [spec, mountpoint]
    }
    return desired
  }

  /**
   * Mount the workspace's backends inside the sandbox, once.
   *
   * Each user mount becomes one in-sandbox mirage command through the
   * provider's own exec API: `mirage mount add <prefix> --fuse <path>`,
   * with the spec in the exec environment (never a file). The sandbox
   * then serves `<workspaceRoot>/<prefix>` live; keeping paths
   * consistent beyond the rebased cwd is the caller's job. Needs an
   * image with mirage baked in (e.g. mirage-python-fuse). Subclasses
   * may replace this wholesale (e.g. a provider volume).
   */
  async mountWorkspace(): Promise<void> {
    if (this.dispatch === null || this.mountPrefixes === null) return
    for (const [prefix, [spec, mountpoint]] of Object.entries(this.desiredMounts())) {
      await this.mountCommand(`mirage mount add ${shQuote(prefix)} --fuse ${shQuote(mountpoint)}`, {
        [MOUNT_SPEC_ENV]: JSON.stringify(spec),
      })
    }
  }

  // One in-sandbox mount command, failing loud; the mount spec rides
  // in the env, never on disk or argv.
  private async mountCommand(command: string, env: Record<string, string>): Promise<void> {
    const result = await this.execLine(command, null, env, '/')
    if (result.exitCode !== 0) {
      const raw = result.stderr !== null && result.stderr.length > 0 ? result.stderr : result.stdout
      const detail = new TextDecoder().decode(raw).trim()
      throw new Error(
        `the in-sandbox mirage mount failed (sandbox runtimes need an ` +
          `image with mirage installed, e.g. mirage-python-fuse): ${detail}`,
      )
    }
  }

  /** Create the provider sandbox and return its id. */
  abstract createSandbox(): Promise<string>

  /** Reattach to a live provider sandbox by the id given at construction. */
  abstract connectSandbox(sandboxId: string): Promise<void>

  /** Execute one shell line inside the sandbox. */
  abstract execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult>

  /** Write one file inside the sandbox at a sandbox-side absolute path. */
  abstract upload(path: string, data: Uint8Array): Promise<void>

  /** Read one file from the sandbox at a sandbox-side absolute path. */
  abstract download(path: string): Promise<Uint8Array>

  abstract close(): Promise<void>
}
