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

import { applyDiff, type Editor, type ToolOutputImage } from '@openai/agents'
import {
  Manifest,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type Entry,
  type ExecCommandArgs,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxDirectoryEntry,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
  type ViewImageArgs,
  type WorkspaceArchiveData,
  type WriteStdinArgs,
} from '@openai/agents/sandbox'
import {
  deserializeManifest,
  elapsedSeconds,
  formatExecResponse,
  imageOutputFromBytes,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  normalizePosixPath,
  posixDirname,
  readOptionalRecord,
  readString,
  serializeManifestRecord,
  shellQuote,
  toUint8Array,
  truncateOutput,
} from '@openai/agents-core/sandbox/internal'
import { FileType } from '@struktoai/mirage-core/types'
import { splitManifestAndBlobs } from '@struktoai/mirage-core/workspace/snapshot/manifest'
import { applyStateDict, toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { readSnapshotTar, writeSnapshotTar } from '@struktoai/mirage-core/workspace/snapshot/tar_io'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import { withRefusal } from '@struktoai/mirage-core/workspace/tools/io_text'
import {
  DEFAULT_EXEC_YIELD_MS,
  DEFAULT_WRITE_YIELD_MS,
  INTERRUPT,
  INTERRUPTED_EXIT_CODE,
  NO_STDIN,
} from './constants.ts'

export interface MirageSandboxSessionState extends SandboxSessionState {
  mirageSessionId: string
}

interface LineOutcome {
  stdout: string
  stderr: string
  exitCode: number
}

class Line {
  readonly controller = new AbortController()
  readonly settled: Promise<void>
  outcome: LineOutcome | null = null
  failure: Error | null = null

  constructor(run: (signal: AbortSignal) => Promise<ExecuteResult>) {
    this.settled = run(this.controller.signal).then(
      (io) => {
        this.outcome = {
          stdout: io.stdoutText,
          stderr: withRefusal(io.stderrText, io.refusal),
          exitCode: io.exitCode,
        }
      },
      (error: unknown) => {
        if (this.controller.signal.aborted) {
          this.outcome = { stdout: '', stderr: '', exitCode: INTERRUPTED_EXIT_CODE }
        } else {
          this.failure = error instanceof Error ? error : new Error(String(error))
        }
      },
    )
  }

  finished(): LineOutcome {
    if (this.failure !== null) throw this.failure
    if (this.outcome === null) throw new Error('line has not settled')
    return this.outcome
  }
}

async function settleWithin(line: Line, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, ms)
  })
  try {
    return await Promise.race([line.settled.then(() => true), expired])
  } finally {
    clearTimeout(timer)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function combinedOutput(outcome: LineOutcome): string {
  const { stdout, stderr } = outcome
  if (stdout !== '' && stderr !== '') {
    return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`
  }
  return stdout || stderr
}

/**
 * One SDK sandbox session, backed by its own Mirage shell session.
 *
 * Every command starts at the manifest root (or the model's `workdir`),
 * the way each `exec_command` is a fresh `sh -lc` in the SDK's other
 * sandboxes, so a `cd` or `export` never outlives its call. Lines of one
 * session run one at a time, like one shell. A line still running after
 * its yield time keeps running and is polled through `writeStdin`.
 */
export class MirageSandboxSession implements SandboxSession<MirageSandboxSessionState> {
  state: MirageSandboxSessionState
  private readonly lines = new Map<number, Line>()
  private nextProcessId = 1
  private closed = false

  constructor(
    readonly workspace: Workspace,
    state: MirageSandboxSessionState,
  ) {
    this.state = state
    workspace.createSession(state.mirageSessionId)
  }

  get sessionId(): string {
    return this.state.mirageSessionId
  }

  supportsPty(): boolean {
    return true
  }

  createEditor(): Editor {
    return {
      createFile: async (op) => {
        const path = this.resolve(op.path)
        try {
          await this.mkdirP(posixDirname(path))
        } catch (error) {
          return { status: 'failed', output: errorText(error) }
        }
        await this.workspace.vfs.write(path, applyDiff('', op.diff, 'create'), this.sessionId)
        return { status: 'completed' }
      },
      updateFile: async (op) => {
        const path = this.resolve(op.path)
        let current: string
        try {
          current = await this.workspace.vfs.cat(path, this.sessionId)
        } catch (error) {
          return { status: 'failed', output: errorText(error) }
        }
        await this.workspace.vfs.write(path, applyDiff(current, op.diff), this.sessionId)
        return { status: 'completed' }
      },
      deleteFile: async (op) => {
        const path = this.resolve(op.path)
        if (!(await this.workspace.vfs.exists(path, this.sessionId))) {
          return { status: 'failed', output: `File not found: ${op.path}` }
        }
        await this.workspace.vfs.unlink(path, this.sessionId)
        return { status: 'completed' }
      },
    }
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    return formatExecResponse(await this.exec(args))
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    const start = Date.now()
    const cwd = this.resolve(args.workdir ?? '.')
    const env = await this.state.manifest.resolveEnvironment()
    const line = new Line((signal) =>
      this.workspace.shell(args.cmd, {
        sessionId: this.sessionId,
        cwd,
        signal,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      }),
    )
    if (!(await settleWithin(line, args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_MS))) {
      const sessionId = this.nextProcessId++
      this.lines.set(sessionId, line)
      return {
        output: '',
        stdout: '',
        stderr: '',
        wallTimeSeconds: elapsedSeconds(start),
        sessionId,
      }
    }
    const outcome = line.finished()
    const output = truncateOutput(combinedOutput(outcome), args.maxOutputTokens)
    return {
      output: output.text,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: outcome.exitCode,
      ...(output.originalTokenCount !== undefined
        ? { originalTokenCount: output.originalTokenCount }
        : {}),
    }
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    const line = this.lines.get(args.sessionId)
    if (line === undefined) {
      return formatExecResponse({
        output: `write_stdin failed: session not found: ${String(args.sessionId)}`,
        wallTimeSeconds: 0,
        exitCode: 1,
      })
    }
    const chars = args.chars ?? ''
    if (chars.split(INTERRUPT).join('') !== '') throw new Error(NO_STDIN)
    if (chars.includes(INTERRUPT)) line.controller.abort()
    const start = Date.now()
    if (!(await settleWithin(line, args.yieldTimeMs ?? DEFAULT_WRITE_YIELD_MS))) {
      return formatExecResponse({
        output: '',
        wallTimeSeconds: elapsedSeconds(start),
        sessionId: args.sessionId,
      })
    }
    this.lines.delete(args.sessionId)
    const outcome = line.finished()
    const output = truncateOutput(combinedOutput(outcome), args.maxOutputTokens)
    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: outcome.exitCode,
      ...(output.originalTokenCount !== undefined
        ? { originalTokenCount: output.originalTokenCount }
        : {}),
    })
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    const bytes = await this.workspace.vfs.read(this.resolve(args.path), {}, this.sessionId)
    return imageOutputFromBytes(args.path, bytes)
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    const bytes = await this.workspace.vfs.read(this.resolve(args.path), {}, this.sessionId)
    if (args.maxBytes !== undefined && bytes.byteLength > args.maxBytes) {
      return bytes.subarray(0, args.maxBytes)
    }
    return bytes
  }

  async listDir(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    const dir = this.resolve(args.path)
    const names = await this.workspace.vfs.readdir(dir, this.sessionId)
    return Promise.all(
      names.map(async (name): Promise<SandboxDirectoryEntry> => {
        const path = name.startsWith('/') ? name : normalizePosixPath(`${dir}/${name}`)
        const stat = await this.workspace.vfs.stat(path, this.sessionId)
        const type =
          stat.type === FileType.DIRECTORY ? 'dir' : stat.type === FileType.FILE ? 'file' : 'other'
        return { name: path.slice(path.lastIndexOf('/') + 1), path, type }
      }),
    )
  }

  async pathExists(path: string): Promise<boolean> {
    return this.workspace.vfs.exists(this.resolve(path), this.sessionId)
  }

  async directoryExists(path: string): Promise<boolean> {
    return this.workspace.vfs.isDir(this.resolve(path), this.sessionId)
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    await this.writeEntry(this.resolve(args.path), args.entry)
    if (!args.path.startsWith('/')) {
      this.state.manifest = mergeManifestEntryDelta(
        this.state.manifest,
        normalizePosixPath(args.path),
        args.entry,
      )
    }
  }

  async applyManifest(manifest: Manifest): Promise<void> {
    await this.materializeManifest(manifest)
    this.state.manifest = mergeManifestDelta(this.state.manifest, manifest)
  }

  async materializeManifest(manifest: Manifest): Promise<void> {
    await this.mkdirP(manifest.root)
    for (const [path, entry] of Object.entries(manifest.entries)) {
      await this.writeEntry(normalizePosixPath(`${manifest.root}/${path}`), entry)
    }
  }

  async persistWorkspace(): Promise<Uint8Array> {
    // The SDK stores a snapshot as one buffer, so the tar is built in
    // memory; it is captured while new lines wait, so the disk files it
    // reads are the ones the lines left.
    return this.workspace.quiesced(async () => {
      const state = await toStateDict(this.workspace)
      const [manifest, blobs] = splitManifestAndBlobs(state as unknown as Record<string, unknown>)
      return writeSnapshotTar(manifest, blobs)
    })
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    const state = (await readSnapshotTar(await toUint8Array(data))) as WorkspaceStateDict
    await applyStateDict(this.workspace, state)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const lines = [...this.lines.values()]
    this.lines.clear()
    for (const line of lines) line.controller.abort()
    await Promise.all(lines.map((line) => line.settled))
    await this.workspace.closeSession(this.sessionId)
  }

  private resolve(path: string): string {
    return normalizePosixPath(path.startsWith('/') ? path : `${this.state.manifest.root}/${path}`)
  }

  private async writeEntry(path: string, entry: Entry): Promise<void> {
    if (entry.type === 'dir') {
      await this.mkdirP(path)
      for (const [name, child] of Object.entries(entry.children ?? {})) {
        await this.writeEntry(normalizePosixPath(`${path}/${name}`), child)
      }
      return
    }
    if (entry.type === 'file') {
      await this.mkdirP(posixDirname(path))
      await this.workspace.vfs.write(path, entry.content, this.sessionId)
      return
    }
    throw new SandboxUnsupportedFeatureError(
      `MirageSandboxClient cannot materialize a ${entry.type} entry`,
      { path, type: entry.type },
    )
  }

  private async mkdirP(path: string): Promise<void> {
    const io = await this.workspace.shell(`mkdir -p -- ${shellQuote(path)}`, {
      sessionId: this.sessionId,
      record: false,
    })
    if (io.exitCode !== 0) throw new Error(io.stderrText.trim())
  }
}

function isSdkDefaultManifest(manifest: Manifest): boolean {
  const base = new Manifest()
  return (
    manifest.root === base.root &&
    Object.keys(manifest.entries).length === 0 &&
    Object.keys(manifest.environment).length === 0 &&
    manifest.users.length === 0 &&
    manifest.groups.length === 0 &&
    manifest.extraPathGrants.length === 0 &&
    JSON.stringify(manifest.remoteMountCommandAllowlist) ===
      JSON.stringify(base.remoteMountCommandAllowlist)
  )
}

/**
 * The manifest a session runs under: the SDK's untouched default becomes
 * the Mirage root, since a workspace need not mount anything at
 * `/workspace`; any configured manifest is kept as given.
 */
function mirageManifest(manifest: Manifest): Manifest {
  return isSdkDefaultManifest(manifest) ? new Manifest({ root: '/' }) : manifest
}

/**
 * The OpenAI Agents SDK sandbox client over an in-process Mirage workspace.
 *
 * Every session shares the one workspace; each gets its own Mirage
 * session. A session the SDK deleted mid-run (an approval pause) is
 * rebuilt from its state on resume, keeping the files the agent wrote.
 */
export class MirageSandboxClient implements SandboxClient<
  SandboxClientOptions,
  MirageSandboxSessionState
> {
  readonly backendId = 'mirage'
  readonly supportsDefaultOptions = true
  private readonly sessions = new Map<string, MirageSandboxSession>()

  constructor(readonly workspace: Workspace) {}

  async create(
    args?: SandboxClientCreateArgs | Manifest,
    options?: SandboxClientOptions,
  ): Promise<MirageSandboxSession> {
    const manifest = mirageManifest(normalizeSandboxClientCreateArgs(args, options).manifest)
    const session = this.open({
      manifest,
      mirageSessionId: `openai-${crypto.randomUUID().replaceAll('-', '')}`,
      workspaceReady: false,
    })
    await this.materializeOrClose(session, manifest)
    return session
  }

  resolveTrustedManifestForResume(manifest: Manifest): Manifest {
    return mirageManifest(manifest)
  }

  async resume(state: MirageSandboxSessionState): Promise<MirageSandboxSession> {
    const live = this.sessions.get(state.mirageSessionId)
    if (live !== undefined) return live
    const session = this.open(state)
    const preserved =
      state.workspaceReady === true &&
      (await this.workspace.vfs.exists(state.manifest.root, session.sessionId))
    if (!preserved) await this.materializeOrClose(session, state.manifest)
    return session
  }

  async delete(state: MirageSandboxSessionState): Promise<void> {
    const session = this.sessions.get(state.mirageSessionId)
    this.sessions.delete(state.mirageSessionId)
    await session?.close()
  }

  serializeSessionState(state: MirageSandboxSessionState): Promise<Record<string, unknown>> {
    return Promise.resolve({
      manifest: serializeManifestRecord(state.manifest),
      mirageSessionId: state.mirageSessionId,
      workspaceReady: state.workspaceReady ?? false,
    })
  }

  deserializeSessionState(record: Record<string, unknown>): Promise<MirageSandboxSessionState> {
    return Promise.resolve({
      manifest: deserializeManifest(readOptionalRecord(record.manifest)),
      mirageSessionId: readString(record, 'mirageSessionId'),
      workspaceReady: record.workspaceReady === true,
    })
  }

  private async materializeOrClose(
    session: MirageSandboxSession,
    manifest: Manifest,
  ): Promise<void> {
    try {
      await session.materializeManifest(manifest)
    } catch (error) {
      await this.delete(session.state)
      throw error
    }
    session.state.workspaceReady = true
  }

  private open(state: MirageSandboxSessionState): MirageSandboxSession {
    const session = new MirageSandboxSession(this.workspace, state)
    this.sessions.set(state.mirageSessionId, session)
    return session
  }
}
