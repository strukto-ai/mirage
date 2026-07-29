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
import {
  DEFAULT_WORKSPACE_ROOT,
  SANDBOX_WORKSPACE_ID,
  SYSTEM_MOUNTS,
  WORKSPACE_CONFIG_ENV,
} from './constants.ts'

/** Per-prefix remote mount specs; null = not remotely mountable. */
export type MountSpecs = Record<string, Record<string, unknown> | null>

/** Constructor options for a RemoteSandbox subclass (a yaml entry's keys). */
export interface RemoteSandboxOptions<C extends SandboxConfig = SandboxConfig> {
  /** Commands that place a whole line here; ["*"] claims every line. */
  captures?: readonly string[]
  /** How to reach the sandbox (a yaml entry's `config` block). */
  config?: C
  /**
   * Where the workspace appears inside the sandbox (/workspace when
   * omitted); pick a directory the sandbox user can write. The
   * workspace becomes visible by running mirage inside the sandbox
   * and FUSE-mounting each remotable mount live, so reads and writes
   * flow both ways with no sync. This needs an image with fuse3 and
   * mirage-ai[<backends>,fuse] installed.
   */
  workspaceRoot?: string
  /** Per-line admission script, the same contract as any runtime. */
  script?: RouteScript
}

/**
 * A runtime that runs whole lines inside a sandbox the user runs.
 *
 * Mirage never creates or deletes sandboxes: you bring your own (a
 * running container, a live Daytona or E2B sandbox) and the provider
 * config says how to reach it. Subclasses adapt one provider by
 * implementing connect() and execLine(); everything else is
 * inherited: routing and captures, per-line scripts, one-time
 * workspace mounting on the first captured line, and the cwd rebase.
 */
export abstract class RemoteSandbox<C extends SandboxConfig = SandboxConfig> implements Runtime {
  abstract readonly name: string
  readonly runsLines = true
  readonly captures: readonly string[]
  readonly config: NormalizedSandboxConfig<C>
  readonly workspaceRoot: string
  script?: RouteScript
  // The mount-once latch: the first captured line connects and mounts
  // the workspace; later lines just execute. Single-flight so
  // concurrent first lines share one start, and a failed start clears
  // the slot so the next line retries.
  private starting: Promise<void> | null = null
  private dispatch: BridgeDispatchFn | null = null
  private mountSpecs: (() => MountSpecs) | null = null

  // Each provider passes its own config key list, so a field the
  // provider does not have fails loud (mirrors Python's config_cls).
  constructor(
    options: RemoteSandboxOptions<C> | Record<string, unknown> = {},
    configKeys?: readonly string[],
  ) {
    const opts = options as RemoteSandboxOptions<C>
    if (typeof opts.script === 'string') throw scriptStringError()
    this.captures = opts.captures !== undefined ? opts.captures.slice() : ['*']
    this.config = coerceConfig(opts.config, configKeys)
    this.workspaceRoot = opts.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    if (typeof opts.script === 'function' || opts.script instanceof ScriptSource) {
      this.script = opts.script
    }
  }

  // The shared runtime contract carries listMounts for the
  // interpreter runtimes; a sandbox needs only the spec map, whose
  // keys already name every mount.
  attach(
    dispatch: BridgeDispatchFn,
    _listMounts: () => string[],
    listMountSpecs?: () => MountSpecs,
  ): void {
    this.dispatch = dispatch
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
   * Run one raw line in the sandbox, mounting the workspace once.
   *
   * The first captured line connects to the user's sandbox and mounts
   * the workspace; every line then executes with the session
   * environment merged over the config environment and the cwd
   * resolved under workspaceRoot.
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

  private ensureStarted(): Promise<void> {
    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = null
      throw err
    })
    return this.starting
  }

  private async start(): Promise<void> {
    await this.connect()
    await this.mountWorkspace()
  }

  /** The session cwd as a path inside the sandbox. */
  sandboxCwd(cwd: string): string {
    const rel = lstripSlash(cwd)
    if (rel === '') return this.workspaceRoot
    return `${rstripSlash(this.workspaceRoot)}/${rel}`
  }

  /**
   * The workspace's user mounts as [spec, sandbox mountpoint].
   *
   * The spec map's keys name every mount, so no separate mount lister
   * is needed. System mounts (/dev, the history view) are excluded:
   * the sandbox has its own, and they are host machinery, not user
   * data. A user mount with no spec fails loud.
   */
  private desiredMounts(): Record<string, [Record<string, unknown>, string]> {
    const specs: MountSpecs = {}
    for (const [raw, spec] of Object.entries(this.mountSpecs?.() ?? {})) {
      const prefix = rstripSlash(raw)
      specs[prefix === '' ? '/' : prefix] = spec
    }
    const prefixes = new Set(Object.keys(specs))
    for (const system of SYSTEM_MOUNTS) prefixes.delete(system)
    // A bare "/" next to real mounts is the synthetic default root,
    // not a user mount; walk it only when it is the whole world.
    if (prefixes.size > 1) prefixes.delete('/')
    const root = rstripSlash(this.workspaceRoot)
    const desired: Record<string, [Record<string, unknown>, string]> = {}
    for (const prefix of [...prefixes].sort()) {
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

  /** The in-sandbox workspace config mirroring the host mounts. */
  private workspaceConfig(): Record<string, unknown> {
    const mounts: Record<string, unknown> = {}
    for (const [prefix, [spec, mountpoint]] of Object.entries(this.desiredMounts())) {
      mounts[prefix] = { ...spec, fuse: mountpoint }
    }
    return { mode: 'EXEC', mounts }
  }

  /**
   * Mount the workspace inside the sandbox, once.
   *
   * Mirage is workspace based, so the sandbox gets exactly one
   * workspace mirroring the host mounts: one in-sandbox
   * `mirage workspace create` through the provider's own exec API,
   * with the config in the exec environment (never a file). The
   * sandbox's daemon then serves `<workspaceRoot>/<prefix>` live;
   * keeping paths consistent beyond the rebased cwd is the caller's
   * job. Needs an image with mirage baked in (e.g.
   * mirage-python-fuse). Subclasses may replace this wholesale (e.g.
   * a provider volume).
   */
  async mountWorkspace(): Promise<void> {
    if (this.dispatch === null || this.mountSpecs === null) return
    const config = this.workspaceConfig()
    // Recreate idempotently: a stale workspace from an earlier attach
    // is dropped, and the line's exit code is create's.
    const command =
      `mirage workspace delete ${SANDBOX_WORKSPACE_ID} >/dev/null 2>&1; ` +
      `mirage workspace create --id ${SANDBOX_WORKSPACE_ID} --from-env`
    const result = await this.execLine(
      command,
      null,
      { [WORKSPACE_CONFIG_ENV]: JSON.stringify(config) },
      '/',
    )
    if (result.exitCode !== 0) {
      const raw = result.stderr !== null && result.stderr.length > 0 ? result.stderr : result.stdout
      const detail = new TextDecoder().decode(raw).trim()
      throw new Error(
        `the in-sandbox mirage workspace create failed (sandbox runtimes ` +
          `need an image with mirage installed, e.g. mirage-python-fuse): ${detail}`,
      )
    }
  }

  /** Attach to the user's live sandbox, failing loud if absent. */
  abstract connect(): Promise<void>

  /** Execute one shell line inside the sandbox. */
  abstract execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult>

  /** Release provider client resources; the sandbox itself is the user's. */
  close(): Promise<void> {
    return Promise.resolve()
  }
}
