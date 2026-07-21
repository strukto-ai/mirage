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

import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import { lstripSlash, rstripSlash } from '../../utils/slash.ts'
import type { BridgeDispatchFn } from './python/mirage_bridge.ts'
import { ScriptSource, type RouteScript } from './route/types.ts'
import { scriptStringError, type RunArgs, type RunResult, type Runtime } from './runtime.ts'

// Virtual mounts the workspace synthesizes; the sandbox has its own.
export const SYSTEM_MOUNTS: ReadonlySet<string> = new Set(['/dev', HISTORY_PREFIX])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Per-prefix remote mount specs; null = not remotely mountable. */
export type MountSpecs = Record<string, Record<string, unknown> | null>

/**
 * Sandbox sizing, mapped onto each provider's create call.
 *
 * Providers that fix sizing in the image or template ignore the fields
 * they cannot honor. `cpu` is cores, `memory`/`disk` are GiB, `gpu` is
 * a count or a type spec for providers that take one.
 */
export interface SandboxResources {
  cpu?: number
  memory?: number
  disk?: number
  gpu?: number | string
}

/** Constructor options for a RemoteSandbox subclass (a yaml entry's keys). */
export interface RemoteSandboxOptions {
  /** Commands that place a whole line here; ["*"] claims every line. */
  captures?: readonly string[]
  /** Provider credential; absent reads the provider's own env variable. */
  apiKey?: string
  /** Image or template name; absent uses the provider default. */
  image?: string
  /** Environment set in the sandbox. */
  env?: Record<string, string>
  /** Sizing, where the provider supports per-sandbox resources. */
  resources?: SandboxResources
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
  readonly image: string | undefined
  readonly env: Record<string, string>
  readonly resources: SandboxResources | undefined
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
  // virtual mount prefix -> its physical mountpoint in this sandbox, and
  // the same as MIRAGE_<PREFIX> env vars, both built once the workspace
  // is mounted. mirage is the control plane: the agent speaks virtual
  // paths and these rewrite them onto the provider.
  private mountMap: Record<string, string> | null = null
  private mountEnv: Record<string, string> = {}

  constructor(options: RemoteSandboxOptions | Record<string, unknown> = {}) {
    const opts = options as RemoteSandboxOptions
    if (typeof opts.script === 'string') throw scriptStringError()
    this.captures = opts.captures !== undefined ? opts.captures.slice() : ['*']
    this.apiKey = opts.apiKey
    this.image = opts.image
    this.env = opts.env !== undefined ? { ...opts.env } : {}
    this.resources = opts.resources
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
   */
  async runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    await this.ensureStarted()
    const merged = { ...this.env, ...this.mountEnv, ...env }
    return this.execLine(this.translateLine(line), stdin, merged, this.sandboxCwd(cwd))
  }

  // Named mounts (/s3, /data) rewrite cleanly; a bare "/" world mount is
  // skipped, as rebasing every absolute path would capture the sandbox's
  // own /usr and /bin.
  private buildTranslation(): void {
    const root = rstripSlash(this.workspaceRoot ?? '/workspace')
    const mountMap: Record<string, string> = {}
    const mountEnv: Record<string, string> = {}
    if (this.mountPrefixes !== null) {
      for (const prefix of this.userMountPrefixes()) {
        if (prefix === '/') continue
        const mountpoint = `${root}/${lstripSlash(prefix)}`
        mountMap[prefix] = mountpoint
        const name = prefix
          .replace(/^\/+|\/+$/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
        mountEnv[`MIRAGE_${name}`] = mountpoint
      }
    }
    this.mountMap = mountMap
    this.mountEnv = mountEnv
  }

  // Rewrite path tokens that begin exactly at a mount prefix (/s3 or
  // /s3/...); siblings (/s3.txt), system paths (/usr/bin), and relative
  // paths are left alone. Longest prefix wins so nested mounts stay right.
  private translateLine(line: string): string {
    const map = this.mountMap
    if (map === null) return line
    let out = line
    for (const prefix of Object.keys(map).sort((a, b) => b.length - a.length)) {
      const target = map[prefix] ?? ''
      const re = new RegExp(`(?<![\\w/.\\-])${escapeRegExp(prefix)}(?=/|$|[^\\w.\\-])`, 'g')
      out = out.replace(re, () => target)
    }
    return out
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
    this.buildTranslation()
  }

  /**
   * The workspaceRoot when none was given, provider-resolved.
   *
   * Called once, after the sandbox is live and before the workspace
   * mounts, so adapters can ask the sandbox itself (e.g. $HOME) for a
   * directory its user can write.
   */
  defaultWorkspaceRoot(): Promise<string> {
    return Promise.resolve('/workspace')
  }

  /** The session cwd as a path inside the sandbox. */
  sandboxCwd(cwd: string): string {
    const root = this.workspaceRoot ?? '/workspace'
    const rel = lstripSlash(cwd)
    if (rel === '') return root
    return `${rstripSlash(root)}/${rel}`
  }

  /**
   * Make the workspace visible inside the sandbox.
   *
   * Starts mirage inside the sandbox and FUSE-mounts each mount's
   * backing store live under workspaceRoot, so reads and writes flow
   * both ways with no sync. Virtual system mounts (/dev, the history
   * view) never appear: the sandbox has its own. Subclasses may replace
   * this wholesale (e.g. a provider volume).
   */
  async mountWorkspace(): Promise<void> {
    if (this.dispatch === null || this.mountPrefixes === null) return
    await this.mountRemoteFuse()
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
   * The sandbox-side workspace config, in the public schema.
   *
   * Each remotable mount is re-declared exactly as a user would write
   * it in a workspace yaml, with `fuse:` naming its live mountpoint
   * under workspaceRoot.
   */
  private fuseWorkspaceConfig(): Record<string, unknown> {
    const specs = this.mountSpecs?.() ?? {}
    const root = rstripSlash(this.workspaceRoot ?? '/workspace')
    const mounts: Record<string, unknown> = {}
    for (const prefix of this.userMountPrefixes()) {
      const spec = specs[prefix] ?? null
      if (spec === null) {
        throw new Error(
          `mount '${prefix}' is not remotely mountable; sandbox runtimes ` +
            `FUSE-mount S3-backed mounts today`,
        )
      }
      mounts[prefix] = { ...spec, fuse: `${root}/${lstripSlash(prefix)}` }
    }
    return { mode: 'exec', mounts }
  }

  /**
   * Mount every remotable mount live via the in-sandbox mirage.
   *
   * Fuse mode is plain mirage usage inside the sandbox: the workspace
   * mounts are re-declared in the standard config schema and created
   * with the same command a user would type, `mirage workspace
   * create`. The CLI auto-spawns the in-sandbox daemon and mounts
   * synchronously, so the exit code is the ready signal and failures
   * arrive on stderr. Needs an image with mirage baked in (e.g.
   * mirage-python-fuse).
   */
  private async mountRemoteFuse(): Promise<void> {
    const root = rstripSlash(this.workspaceRoot ?? '/workspace')
    const config = this.fuseWorkspaceConfig()
    const cut = root.lastIndexOf('/')
    const parent = cut <= 0 ? '/' : root.slice(0, cut)
    const configPath = `${parent === '/' ? '' : parent}/.mirage-workspace.json`
    await this.upload(configPath, new TextEncoder().encode(JSON.stringify(config)))
    const result = await this.execLine(`mirage workspace create ${configPath}`, null, {}, parent)
    if (result.exitCode !== 0) {
      const raw = result.stderr !== null && result.stderr.length > 0 ? result.stderr : result.stdout
      const detail = new TextDecoder().decode(raw).trim()
      throw new Error(
        `the in-sandbox mirage FUSE mount failed (mount: 'fuse' needs an ` +
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
