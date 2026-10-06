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

// The in-app access on the TypeScript host. Reads one suite as JSON on
// stdin ({suite, prefix, config, scratch}), runs it with Workspace and
// Session, and prints one canonical answer per case as JSON, the same
// answers integ/access/adapters.py gives on the Python host. Run from
// integ/ by the runner: `node --import tsx access/inapp.ts`.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import {
  Outcome,
  Workspace,
  configToWorkspaceArgs,
  loadWorkspaceConfigFile,
} from '@struktoai/mirage-node'

type Json = Record<string, unknown>
type Answer = Record<string, unknown>
type Session = Awaited<ReturnType<Workspace['session']>>
type Vfs = Session['vfs']
interface Case {
  id: string
  input: Json
}
interface Suite {
  id: string
  op: string
  setup?: string[]
  session?: { id: string; profile: string }
  cases: Case[]
}

const STEP_OPS = new Set(['workspace', 'session_admin', 'snapshot', 'ask'])
const WAITED = 'the line waited for all of its input'
const STREAM_WAIT_MS = 10_000
const encoder = new TextEncoder()

function shellAnswer(stdout: string, stderr: string, code: number): Answer {
  const text = stdout !== '' && stderr !== '' ? `${stdout}\n${stderr}` : stdout || stderr
  return { text, is_error: code !== 0 }
}

function stdinBytes(spec: string | { repeat: string; times: number }): Uint8Array {
  return encoder.encode(typeof spec === 'string' ? spec : spec.repeat.repeat(spec.times))
}

function prefixOf(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

function entries(path: string, names: readonly string[]): string[] {
  const base = path.replace(/\/+$/, '')
  return names.map((n) => (n.startsWith('/') ? n : `${base}/${n}`)).sort()
}

function missing(error: unknown): boolean {
  const e = error as { code?: string; errno?: string; message?: string }
  return (
    e.code === 'ENOENT' || e.errno === 'ENOENT' || /ENOENT|No such file/.test(String(e.message))
  )
}

async function build(config: Json, path: string): Promise<Workspace> {
  writeFileSync(path, JSON.stringify(config))
  const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(path))
  return new Workspace({ ...args.mounts }, { ...args.options })
}

async function streamed(session: Session, step: Json): Promise<Answer> {
  const [first, ...rest] = step.stream as string[]
  let done = false
  let waited = false
  async function* produce(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(first)
    const deadline = Date.now() + STREAM_WAIT_MS
    while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    waited = !done
    for (const chunk of rest) yield encoder.encode(chunk)
  }
  const io = await session.shell(step.command as string, { stdin: produce() })
  done = true
  if (waited) return { text: WAITED, is_error: true }
  return shellAnswer(io.stdoutText, io.stderrText, io.exitCode)
}

async function bytes(vfs: Vfs, step: Json): Promise<Answer> {
  const call = step.call as string
  const path = (step.path as string | undefined) ?? ''
  try {
    if (call === 'mkdir') await vfs.mkdir(path)
    else if (call === 'write')
      await vfs.write(path, Buffer.from(step.data_base64 as string, 'base64'))
    else if (call === 'read')
      return { data_base64: Buffer.from(await vfs.read(path)).toString('base64') }
    else if (call === 'stat') {
      const stat = await vfs.stat(path)
      return { type: String(stat.type), size: stat.size }
    } else if (call === 'readdir') return { entries: entries(path, await vfs.readdir(path)) }
    else if (call === 'rename') await vfs.rename(step.src as string, step.dst as string)
    else if (call === 'unlink') await vfs.unlink(path)
    else throw new Error(`unknown call ${call}`)
  } catch (error) {
    if (missing(error)) return { error: 'ENOENT' }
    throw error
  }
  return {}
}

async function caseAnswer(
  op: string,
  session: Session,
  tools: Session['tools'],
  step: Json,
): Promise<Answer> {
  if (op === 'shell' || op === 'session') {
    const io = await session.shell(step.command as string)
    return shellAnswer(io.stdoutText, io.stderrText, io.exitCode)
  }
  if (op === 'stdin' && step.stream !== undefined) return streamed(session, step)
  if (op === 'stdin') {
    const io = await session.shell(step.command as string, {
      stdin: stdinBytes(step.stdin as string),
    })
    return shellAnswer(io.stdoutText, io.stderrText, io.exitCode)
  }
  if (op === 'tool') {
    const result = await tools.call(step.tool as string, step.arguments as Json)
    return { text: result.content[0]?.text ?? '', is_error: result.isError === true }
  }
  if (op === 'bytes') return bytes(session.vfs, step)
  if (op === 'cancel') {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 500)
    try {
      await session.shell(step.command as string, { signal: stop.signal })
    } catch {
      return { text: 'canceled' }
    }
    return { text: stop.signal.aborted ? 'canceled' : 'finished' }
  }
  throw new Error(`unknown op ${op}`)
}

async function steps(
  suite: Suite,
  prefix: string,
  config: Json,
  scratch: string,
  store: S3Config,
): Promise<Answer[]> {
  const workspaces = new Map<string, Workspace>()
  const declared = new Set(Object.keys(config.mounts as Json).map(prefixOf))
  const named = new Set<string>()
  const answers: Answer[] = []
  const get = (id: string): Workspace => {
    const ws = workspaces.get(id)
    if (ws === undefined) throw new Error(`no workspace ${id}`)
    return ws
  }
  try {
    for (const c of suite.cases) {
      const step = c.input
      const kind = step.step as string
      const wid = typeof step.id === 'string' ? prefix + step.id : ''
      if (kind === 'create') {
        workspaces.set(
          wid,
          await build({ ...config, workspace_id: wid }, join(scratch, `${wid}.json`)),
        )
        answers.push({ text: step.id })
      } else if (kind === 'shell') {
        const ws = get(wid)
        const io =
          typeof step.session === 'string'
            ? await (await ws.session(step.session)).shell(step.command as string)
            : await ws.shell(step.command as string)
        answers.push(shellAnswer(io.stdoutText, io.stderrText, io.exitCode))
      } else if (kind === 'list') {
        const own = [...workspaces.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
        answers.push({ text: own.sort().join(' ') })
      } else if (kind === 'mounts') {
        const found = get(wid)
          .mounts()
          .map((m) => prefixOf(m.prefix))
        answers.push({ text: [...new Set(found.filter((p) => declared.has(p)))].sort().join(' ') })
      } else if (kind === 'clone') {
        workspaces.set(prefix + (step.to as string), await get(wid).copy())
        answers.push({ text: step.to })
      } else if (kind === 'delete') {
        await get(wid).close()
        workspaces.delete(wid)
        answers.push({ text: 'deleted' })
      } else if (kind === 'session_create') {
        get(wid).createSession(step.session as string, { profile: step.profile as string })
        named.add(step.session as string)
        answers.push({ text: step.session })
      } else if (kind === 'session_list') {
        const found = get(wid)
          .listSessions()
          .map((s) => s.sessionId)
        answers.push({
          text: found
            .filter((id) => named.has(id))
            .sort()
            .join(' '),
        })
      } else if (kind === 'session_delete') {
        await get(wid).closeSession(step.session as string)
        answers.push({ text: 'deleted' })
      } else if (kind === 'cancel_lines') {
        const session = typeof step.session === 'string' ? step.session : undefined
        answers.push({ text: String(await get(wid).cancel(session)) })
      } else if (kind === 'kill_jobs') {
        const session = typeof step.session === 'string' ? step.session : undefined
        answers.push({ text: String(await get(wid).kill(session)) })
      } else if (kind === 'close_workspace') {
        await get(wid).close()
        workspaces.delete(wid)
        answers.push({ text: 'closed' })
      } else if (kind === 'snapshot') {
        await get(wid).snapshot(join(scratch, prefix + (step.name as string)))
        answers.push({ text: 'saved' })
      } else if (kind === 'load') {
        workspaces.set(
          prefix + (step.to as string),
          await Workspace.load(join(scratch, prefix + (step.name as string))),
        )
        answers.push({ text: step.to })
      } else if (kind === 'store_snapshot') {
        await get(wid).snapshot(prefix + (step.key as string), { s3: store })
        answers.push({ text: 'saved' })
      } else if (kind === 'store_load') {
        workspaces.set(
          prefix + (step.to as string),
          await Workspace.load(prefix + (step.key as string), { s3: store }),
        )
        answers.push({ text: step.to })
      } else if (kind === 'asks') {
        answers.push({
          text: get(wid)
            .decisions.pending()
            .map((d) => d.reason)
            .join('\n'),
        })
      } else if (kind === 'explain') {
        const explain = (await get(wid).session(step.session as string)).explain
        const said = await explain.shell(step.command as string)
        answers.push({ text: `${said.outcome} ${String(said.exitCode)}` })
      } else if (kind === 'allow' || kind === 'deny') {
        const pending = get(wid).decisions.pending()
        const outcome = kind === 'allow' ? Outcome.ALLOW : Outcome.DENY
        await get(wid).decisions.answer(pending[0]?.id ?? '', outcome)
        answers.push({ text: kind === 'allow' ? 'allowed' : 'denied' })
      } else {
        throw new Error(`unknown step ${kind}`)
      }
    }
  } finally {
    for (const ws of workspaces.values()) await ws.close()
  }
  return answers
}

async function main(): Promise<void> {
  const request = JSON.parse((await buffer(process.stdin)).toString()) as {
    suite: Suite
    prefix: string
    config: Json
    scratch: string
    store: S3Config
  }
  const { suite, prefix, config, scratch, store } = request
  if (STEP_OPS.has(suite.op)) {
    console.log(JSON.stringify(await steps(suite, prefix, config, scratch, store)))
    return
  }
  const ws = await build(config, join(scratch, 'workspace.json'))
  try {
    for (const line of suite.setup ?? []) {
      const io = await ws.shell(line)
      if (io.exitCode !== 0) throw new Error(`setup failed: ${line}: ${io.stderrText}`)
    }
    const session =
      suite.session !== undefined
        ? await ws.session(suite.session.id, { profile: suite.session.profile })
        : await ws.session(ws.defaultSessionId)
    const tools = session.tools
    const answers: Answer[] = []
    for (const c of suite.cases) answers.push(await caseAnswer(suite.op, session, tools, c.input))
    console.log(JSON.stringify(answers))
  } finally {
    await ws.close()
  }
}

await main()
