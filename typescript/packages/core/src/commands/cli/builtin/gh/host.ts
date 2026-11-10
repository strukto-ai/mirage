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

import type { util } from 'zod'
import type { GitHubAccount } from '../../../../accessor/github.ts'
import { API_BASE } from '../../../../core/github/constants.ts'
import { GitHubApiError, GitHubConnectionError } from '../../../../core/github/client.ts'
import { Engine, JqCompileError, localZone, type Ending } from '../../../../core/jq/index.ts'
import { fsStrerror, isEnoent, isEnotdir } from '../../../../errors/fs.ts'
import { checkMemory } from '../../../../io/memory.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import { StreamModule, serveRequests, type OpenStream, type Served } from '../../../../rs/stream.ts'
import { PathSpec } from '../../../../types.ts'
import { concat } from '../../../../utils/bytes.ts'
import { systemNow } from '../../../../utils/clock.ts'
import { VERSION } from '../../../../version.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { cobraRefusal, setsValueFlag } from '../../cobra.ts'
import { CONNECT_HINT, GITHUB_HOST } from './constants.ts'

type Request = Readonly<Record<string, unknown>>

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

/** Refuse a repository on a host this install cannot reach, in gh's words. */
export function checkHost(accessor: GitHubAccount, host: string | null): void {
  if (host === null) return
  const name = host.toLowerCase()
  if (name === GITHUB_HOST || name.endsWith(`.${GITHUB_HOST}`)) return
  const base = accessor.config.baseUrl
  if (base !== undefined && URL.canParse(base) && new URL(base).hostname === name) return
  throw new Error(`error connecting to ${name}\n${CONNECT_HINT}`)
}

/** The origin the install's GitHub serves its pages and git from. */
export function webOrigin(accessor: GitHubAccount): string {
  const base = accessor.config.baseUrl
  if (base === undefined || base.replace(/\/+$/, '') === API_BASE) {
    return `https://${GITHUB_HOST}`
  }
  let url: URL
  try {
    url = new URL(base)
  } catch (err) {
    throw new TypeError('Invalid URL', { cause: err })
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Invalid URL')
  return url.origin
}

/** Read a path-valued CLI option from the VFS, or `-` from stdin. */
export async function readCliFile(
  ctx: Context,
  raw: FlagValue,
  option: string,
): Promise<Uint8Array> {
  if (!(raw instanceof PathSpec) && typeof raw !== 'string') {
    throw new Error(`${option} expects a file`)
  }
  const path = raw instanceof PathSpec ? raw.rawPath : raw
  if (path === '-') {
    if (ctx.stdin === null) throw new Error(`${option} needs standard input`)
    return materialize(ctx.stdin)
  }
  const vfs = ctx.vfs
  if (vfs === undefined) throw new Error(`${option} needs a workspace to read files from`)
  const spec = PathSpec.fromStrPath(raw, undefined, ctx.cwd)
  try {
    return await vfs.read(spec)
  } catch (err) {
    const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
    if (strerror !== null) throw new Error(`open ${path}: ${strerror.toLowerCase()}`)
    throw err
  }
}

let ghModule: StreamModule | undefined

// gh's module stays apart from the main one and loads the first time gh runs.
async function openGhStream(config: Readonly<Record<string, util.JSONType>>): Promise<OpenStream> {
  if (ghModule === undefined) {
    const { default: source } = await import('#mirage-gh-wasm')
    ghModule = new StreamModule(source)
  }
  return ghModule.open('gh', config)
}

function pairs(value: unknown): Record<string, string> | undefined {
  const entries = value as [string, string][]
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** What a gh stream asks its host for: GitHub calls, the files its options name, its `--jq` programs, and how it ended. */
class GhHost {
  readonly stderr: Uint8Array[] = []
  readonly errors = {
    append: (data: Uint8Array): Promise<void> => {
      if (data.byteLength > 0) this.stderr.push(data)
      return Promise.resolve()
    },
  }
  failure: Request | null = null

  constructor(
    private readonly accessor: GitHubAccount,
    private readonly ctx: Context,
  ) {}

  private async http(request: Request, data: Uint8Array): Promise<Served> {
    const transport = this.accessor.transport
    if (transport.requestRaw === undefined) throw new Error('gh: this transport cannot run gh')
    const body =
      request.has_body !== true
        ? undefined
        : request.raw_body === true
          ? data
          : (JSON.parse(DECODER.decode(data)) as unknown)
    try {
      const response = await transport.requestRaw(
        request.method as string,
        request.path as string,
        body,
        pairs(request.params),
        pairs(request.headers),
      )
      return {
        reply: { status: response.status, headers: response.headers },
        data: response.data as Uint8Array,
      }
    } catch (err) {
      if (err instanceof GitHubApiError) {
        return {
          reply: {
            status: err.status,
            headers: err.headers,
            url: err.url,
            message: err.message,
          },
          data: ENCODER.encode(err.body),
        }
      }
      if (err instanceof GitHubConnectionError) return { reply: { error: err.message } }
      throw err
    }
  }

  private async readFile(request: Request): Promise<Served> {
    const flag = request.flag
    const raw = typeof flag === 'string' ? this.ctx.flags[flag] : request.path
    try {
      const data = await readCliFile(this.ctx, raw as FlagValue, request.option as string)
      return { reply: {}, data }
    } catch (err) {
      if (err instanceof Error && err.constructor === Error)
        return { reply: { error: err.message } }
      throw err
    }
  }

  private async jq(request: Request, data: Uint8Array): Promise<Served> {
    const { env, signal } = this.ctx
    let engine: Engine
    try {
      engine = await Engine.open(
        request.program as string,
        JSON.stringify(env ?? {}),
        localZone(env),
        signal,
      )
    } catch (err) {
      if (err instanceof JqCompileError || err instanceof StreamRefusal) {
        return { reply: { error: err.message } }
      }
      throw err
    }
    const ending: Ending = { stop: null }
    const outputs: string[] = []
    try {
      for await (const text of engine.run(DECODER.decode(data), ending)) outputs.push(text)
    } finally {
      await engine.close()
    }
    const stop = ending.stop
    const reply: Record<string, util.JSONType> =
      stop === null
        ? {}
        : stop.kind === 'error'
          ? { kind: 'error', message: stop.text, string: stop.string, own: stop.own ?? false }
          : { kind: 'halt', message: stop.message, string: stop.string }
    return { reply, data: ENCODER.encode(outputs.join('\n')) }
  }

  serve(request: Request, data: Uint8Array): Promise<Served> {
    switch (request.op) {
      case 'http':
        return this.http(request, data)
      case 'read_file':
        return this.readFile(request)
      case 'jq':
        return this.jq(request, data)
      case 'now':
        return Promise.resolve({ reply: { now: systemNow() } })
      case 'memory':
        checkMemory(Number(request.size))
        return Promise.resolve({ reply: {} })
      case 'fail':
        this.failure = request
        return Promise.resolve({ reply: {} })
      default:
        throw new Error(`gh: unknown host request ${String(request.op)}`)
    }
  }
}

/** The token as `gh auth status` shows it: its prefix, the rest starred. */
export function maskedToken(token: string): string {
  const prefix = token.slice(0, token.lastIndexOf('_') + 1)
  return prefix + '*'.repeat(token.length - prefix.length)
}

function flagValue(value: FlagValue): util.JSONType {
  return value instanceof PathSpec ? { path: value.rawPath } : (value as util.JSONType)
}

/** Run one subcommand's mirage-rs body, answering what it asks. */
export async function runLeaf(
  leaf: string,
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const config = accessor.config
  const stream = await openGhStream({
    leaf,
    flags: Object.fromEntries(
      Object.entries(ctx.flags).map(([name, value]) => [name, flagValue(value)]),
    ),
    texts: [...texts],
    repo: config.repo ?? null,
    branch: config.branch ?? null,
    token_mask: maskedToken(config.token),
    base_url: config.baseUrl ?? null,
    version: VERSION,
    argv_len: ctx.argv?.length ?? 0,
    argv: [...(ctx.argv ?? [])],
    value_flag: ctx.spec !== undefined && setsValueFlag(ctx.spec, ctx.argv ?? []),
  })
  const host = new GhHost(accessor, ctx)
  const output: Uint8Array[] = []
  let status = 0
  try {
    for await (const chunk of serveRequests(stream, host, ctx.signal)) output.push(chunk)
    status = stream.status()
  } finally {
    stream.close()
  }
  const failure = host.failure
  if (failure === null) {
    return [concat(output), new IOResult({ exitCode: status, stderr: concat(host.stderr) })]
  }
  const said = failure.message as string
  const message =
    failure.kind === 'usage' && ctx.spec !== undefined
      ? cobraRefusal(said, `gh ${leaf}`, ctx.spec)
      : said.endsWith('\n')
        ? said
        : `${said}\n`
  return [
    concat(output),
    new IOResult({ exitCode: failure.code as number, stderr: ENCODER.encode(message) }),
  ]
}
