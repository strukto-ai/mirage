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

import { Outcome, Scope } from '@struktoai/mirage-core/policy/index'
import { parseSessionProfile, type SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

export interface Expect {
  exit: number
  stdout: string
  stderr: string
  // The stat line the case's `check` must produce, asserted alongside stdout
  // rather than in place of it.
  check?: string
  elapsed?: { min: number; max: number }
}

export interface StatCheck {
  read_paths?: boolean
  stat?: string
  fields?: string[]
  read?: string
  offset?: number
  size?: number | null
}

export interface Case {
  session_profiles?: Record<string, unknown>
  documents?: { kind: 'vfs' | 'skill'; path: string; session?: string }[]
  id: string
  seq?: number
  targets: string[]
  command: string
  flags?: string[]
  check?: StatCheck
  clear_cache?: boolean
  // A scenario selector, not a config value: a case names the read policy
  // its two workspaces run under. `ttl` rides beside it because `bounded`
  // takes a bound.
  read?: 'fresh' | 'bounded'
  ttl?: number
  mount_read?: Record<string, 'fresh' | 'bounded'>
  session?: string
  // The host's answer to every approval waiting on the workspace, given
  // before the command runs: `allow_once`, `allow_session` or `deny`.
  // How a case exercises the ask arm, since the battery has no host of
  // its own.
  answer?: 'allow_once' | 'allow_session' | 'deny'
  // Why this case's verdict is out of reach of `ws.explain`, which reads
  // the command plane and the line as typed: a runtime-expanded glob, a
  // refusal from the op door below the gate, a function the same line
  // defines. Named rather than silently omitted.
  explain_blind?: string
  scenario?: ScenarioStep[]
  expect: Expect
  _source?: string
}

export type ScenarioStep =
  | {
      mutate:
        | { path: string; content: string; delete?: false }
        | { path: string; delete: true }
        | { command: string }
    }
  | { command: string }

export interface ExplainedNode {
  readonly children: readonly ExplainedNode[]
  readonly command?: string
  readonly exitCode?: number
  readonly stderr?: string
}

export interface ExplainedLine {
  readonly exitCode: number
  readonly stderr: string
  readonly node: ExplainedNode
}

export interface ExecResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface HarnessStat {
  mode: number | null
  uid: number | string | null
  gid: number | string | null
  modified: string | null
}

export interface ExecWorkspace {
  vfs: { records: readonly { op: string; path: string }[] }
  shell(cmd: string, opts?: { stdin?: Uint8Array; sessionId?: string }): Promise<ExecResult>
  dispatch(
    name: string,
    path: string,
    args?: readonly unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<unknown>
  cache: { clear(): Promise<void> }
  mounts(): readonly { vfs: { index?: { clear(): Promise<void> } } }[]
  createSession(
    sessionId: string,
    options: { profile?: string | SessionProfile; permissions?: SessionProfile },
  ): unknown
  listSessions(): readonly { sessionId: string }[]
  setSessionProfile(sessionId: string, profile: SessionProfile): Promise<unknown>
  vfsMd(path?: string, options?: { sessionId?: string }): Promise<string>
  skillMd(path?: string, options?: { sessionId?: string }): Promise<string>
  env: Record<string, string>
  decisions: {
    pending(): readonly { id: string }[]
    answer(id: string, outcome: Outcome, scope?: Scope): Promise<void>
  }
  explain(line: string, sessionId?: string): Promise<ExplainedLine>
  close(): Promise<void>
}

function checkField(st: HarnessStat, name: string): string {
  let value: string
  if (name === 'mode') {
    value = st.mode !== null ? st.mode.toString(8) : '-'
  } else if (name === 'uid') {
    value = st.uid !== null ? String(st.uid) : '-'
  } else if (name === 'gid') {
    value = st.gid !== null ? String(st.gid) : '-'
  } else {
    // First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
    // never reaches the comparison.
    value = st.modified !== null && st.modified !== '' ? st.modified.slice(0, 19) : '-'
  }
  return `${name}=${value}`
}

/**
 * The probe a case runs beside its command, as one printable line.
 *
 * Two forms. `stat` names a path and the FileStat fields to print. `read`
 * names a path and a byte window, and prints what that window returned: no
 * shell command asks for one, because commands read whole files, so the
 * ranged read op is only reachable through the same door FUSE and `ws.vfs`
 * use.
 */
export async function statCheck(ws: ExecWorkspace, check: StatCheck): Promise<string> {
  if (check.read !== undefined) {
    const data = (await ws.dispatch('read', check.read, [], {
      offset: check.offset ?? 0,
      size: check.size ?? null,
    })) as Uint8Array
    return new TextDecoder().decode(data)
  }
  let st: HarnessStat
  try {
    st = (await ws.dispatch('stat', check.stat ?? '')) as HarnessStat
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'absent\n'
    throw err
  }
  return (check.fields ?? []).map((name) => checkField(st, name)).join(' ') + '\n'
}

/**
 * Substitute {mount} in a case with a target's primary mount path.
 *
 * Lets one case assert a behavior that every backend shares while each target
 * keeps its own mount path. Cases without the token are returned untouched, so
 * this is inert for the existing suite.
 */
// {mount} lets one case assert a behavior every backend shares while each
// target keeps its own mount path. {http} carries the fixture HTTP server's
// base URL, which is only known once the server has bound a port.
export function bindMount(c: Case, mountPath: string): Case {
  // A browser page has no `process`; only a node run serves {http}.
  const http = typeof process === 'undefined' ? '' : (process.env.HTTP_ENDPOINT ?? '')
  const tokens: ReadonlyArray<readonly [string, string]> = [
    ['{mount}', rstripSlash(mountPath)],
    ['{http}', http],
  ]
  const subst = (text: string): string =>
    tokens.reduce((acc, [token, value]) => acc.split(token).join(value), text)
  const present = tokens.some(
    ([token]) =>
      c.command?.includes(token) === true ||
      c.expect.stdout.includes(token) ||
      c.expect.stderr.includes(token) ||
      c.check?.stat?.includes(token) === true ||
      c.check?.read?.includes(token) === true ||
      c.expect.check?.includes(token) === true,
  )
  if (!present) return c
  const check =
    c.check === undefined
      ? undefined
      : {
          ...c.check,
          ...(c.check.stat !== undefined ? { stat: subst(c.check.stat) } : {}),
          ...(c.check.read !== undefined ? { read: subst(c.check.read) } : {}),
        }
  return {
    ...c,
    ...(c.command !== undefined ? { command: subst(c.command) } : {}),
    ...(check !== undefined ? { check } : {}),
    expect: {
      ...c.expect,
      stdout: subst(c.expect.stdout),
      stderr: subst(c.expect.stderr),
      ...(c.expect.check !== undefined ? { check: subst(c.expect.check) } : {}),
    },
  }
}

/**
 * Run one case and return what it produced.
 *
 * The post-condition a case declares under `check` is returned beside stdout
 * rather than in place of it, so a case can pin both what the command printed
 * and what it left behind.
 */
/**
 * What each of the battery's words answers with. DENY is ONCE because a
 * refusal answers the one retry it was given for; a session-wide deny
 * would be a rule, which is the document's job and not a host's.
 */
const ANSWERS = new Map<string, readonly [Outcome, Scope]>([
  ['allow_once', [Outcome.ALLOW, Scope.ONCE]],
  ['allow_session', [Outcome.ALLOW, Scope.SESSION]],
  ['deny', [Outcome.DENY, Scope.ONCE]],
])

/**
 * The host's side of the ask arm: answer every approval waiting on the
 * workspace the way the case says, so the command that follows finds
 * the answer (or the refusal) the way an agent's retry would.
 *
 * The word is looked up before anything is answered, so a case that
 * misspells one fails loudly here. The literal union on `Case` is a
 * compile-time promise about a value that arrives from JSON, so it does
 * not reach this far on its own; without the lookup every word that was
 * not `allow_once` fell through to a session-wide allow, and a typo
 * passed the case while testing the most permissive answer there is.
 */
async function answerDecisions(ws: ExecWorkspace, answer: string): Promise<void> {
  const pair = ANSWERS.get(answer)
  if (pair === undefined) {
    throw new Error(`case answer must be one of ${[...ANSWERS.keys()].join(', ')}, got ${answer}`)
  }
  const [outcome, scope] = pair
  for (const record of ws.decisions.pending()) {
    await ws.decisions.answer(record.id, outcome, scope)
  }
}

/**
 * Every reason a document's rules can speak with.
 *
 * These are what a refusal the policy layer wrote looks like on the wire,
 * and they are distinctive enough ("sealed until review") to tell one
 * apart from an ordinary command failure, which is what `explainNotes`
 * needs to check the direction a prediction cannot check on its own.
 */
export function ruleReasons(doc: unknown): string[] {
  const found = new Set<string>()
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
    } else if (node !== null && typeof node === 'object') {
      const rec = node as Record<string, unknown>
      if (typeof rec['reason'] === 'string') found.add(rec['reason'])
      stack.push(...Object.values(rec))
    }
  }
  return [...found].sort()
}

/**
 * What `explain` says would refuse this line, null when it says the line
 * runs. A rule's refusal is the line's: the first one holds the whole
 * line before any of it runs. Any other refusal fails only its own
 * command and the line goes on (`tar` refused on a mount root, then
 * `echo after`), so it is the line's only when that command is the line.
 */
async function predictedRefusal(ws: ExecWorkspace, c: Case): Promise<[number, string] | null> {
  const said = await ws.explain(c.command, c.session ?? '')
  if (said.exitCode !== 0) return [said.exitCode, said.stderr]
  const commands = commandsOf(said.node)
  const [only] = commands
  if (commands.length === 1 && only?.exitCode !== undefined && only.exitCode !== 0) {
    return [only.exitCode, only.stderr ?? '']
  }
  return null
}

/** Every command under a node of an explained line, in source order. */
function commandsOf(node: ExplainedNode): ExplainedNode[] {
  const mine = node.command === undefined ? [] : [node]
  return [...mine, ...node.children.flatMap(commandsOf)]
}

/**
 * Where the dry run and the run disagreed, empty when they agree.
 *
 * Three properties, checked against every policy case rather than only
 * the unit tests, because each is a promise the whole surface makes and
 * none of them is visible in a golden.
 *
 * A dry run must record no question, or a host fields requests for lines
 * nobody typed. A refusal it predicts must be the refusal that arrives.
 * And the harder direction: a refusal that arrives must have been
 * predicted, which is checked by looking for one of the document's own
 * rule reasons on an operand refusal's record, the one a rule naming the
 * line's operand writes (the streams keep bash's words, and a walk's
 * refusal below the operand is the command's). That last one is the
 * direction a prediction cannot check on its own, and it is where the
 * bugs were: reading a line without its redirect target answered ALLOW
 * for a line the run refused.
 *
 * The predicted message is looked for on either stream because the line's
 * own redirections still apply to the run and not to the prediction:
 * `rm /denied 2>&1` is refused on stdout.
 */
export function explainNotes(
  predicted: [number, string] | null,
  recorded: number,
  exitCode: number,
  out: string,
  err: string,
  reasons: readonly string[],
  refused: string,
): string[] {
  const notes: string[] = []
  if (recorded !== 0) {
    notes.push(`explain: recorded ${recorded} question(s), must record none`)
  }
  const spoke = reasons.find((r) => r !== '' && refused.includes(r))
  if (predicted === null) {
    if (spoke !== undefined) {
      notes.push(`explain: said the line runs, but a rule refused it with ${JSON.stringify(spoke)}`)
    }
    return notes
  }
  const [code, text] = predicted
  if (code !== exitCode) notes.push(`explain: predicted exit ${code}, run exited ${exitCode}`)
  if (text !== '' && !err.includes(text) && !out.includes(text)) {
    notes.push(
      `explain: predicted stderr ${JSON.stringify(text)}, run wrote ${JSON.stringify(err)}`,
    )
  }
  return notes
}

/**
 * Name each stream whose bytes are not UTF-8. The battery compares a
 * replacing decode, which reads a raw byte as U+FFFD, so a host that printed
 * the byte and one that printed U+FFFD would pass alike. A case whose output
 * is not text pins its bytes through `od -An -tx1` instead.
 */
export function undecodable(streams: Record<string, Uint8Array>): string[] {
  return Object.entries(streams)
    .filter(([, raw]) => {
      const back = ENC.encode(DEC.decode(raw))
      return back.length !== raw.length || back.some((b, i) => b !== raw[i])
    })
    .map(([name]) => `${name}: not UTF-8; pin the bytes with od -An -tx1`)
}

export async function runCase(
  ws: ExecWorkspace,
  c: Case,
  reasons: readonly string[] = [],
): Promise<{
  exitCode: number
  out: string
  err: string
  elapsed: number
  checkOut: string | null
  notes: string[]
}> {
  for (const [id, raw] of Object.entries(c.session_profiles ?? {})) {
    const profile = parseSessionProfile(raw, `session ${id}`)
    if (ws.listSessions().some((session) => session.sessionId === id))
      await ws.setSessionProfile(id, profile)
    else ws.createSession(id, { profile })
  }
  for (const document of c.documents ?? []) {
    const options = document.session === undefined ? {} : { sessionId: document.session }
    if (document.kind === 'vfs') await ws.vfsMd(document.path, options)
    else await ws.skillMd(document.path, options)
  }
  if (c.clear_cache === true) {
    // A full clear means the file cache AND every mount's index cache:
    // remote listings live in the mount's index, and a listing
    // populated by an earlier case must not leak into this one. Every
    // mount carries a store, built when its driver was placed, so there
    // is nothing to probe for.
    await ws.cache.clear()
    for (const m of ws.mounts()) await m.indexStore.clear()
  }
  const start = performance.now()
  if (c.answer !== undefined) await answerDecisions(ws, c.answer)
  const checks = reasons.length > 0 && c.explain_blind === undefined
  let predicted: [number, string] | null = null
  let recorded = 0
  if (checks) {
    const before = ws.decisions.pending().length
    predicted = await predictedRefusal(ws, c)
    // Counted here, not after the run: the run records its own question,
    // and charging that to the dry run would fail every ask case.
    recorded = ws.decisions.pending().length - before
  }
  const recordStart = c.check?.read_paths === true ? ws.vfs.records.length : 0
  const result = await ws.shell(c.command, c.session === undefined ? {} : { sessionId: c.session })
  const elapsed = (performance.now() - start) / 1000
  const out = DEC.decode(result.stdout)
  const err = DEC.decode(result.stderr)
  const checkOut =
    c.check?.read_paths === true
      ? JSON.stringify(
          ws.vfs.records
            .slice(recordStart)
            .filter((r) => r.op === 'read')
            .map((r) => r.path),
        ) + '\n'
      : c.check !== undefined
        ? await statCheck(ws, c.check)
        : null
  return {
    exitCode: result.exitCode,
    out,
    err,
    elapsed,
    checkOut,
    notes: [
      ...undecodable({ stdout: result.stdout, stderr: result.stderr }),
      ...(checks
        ? explainNotes(
            predicted,
            recorded,
            result.exitCode,
            out,
            err,
            reasons,
            result.refusal?.scope === 'operand' ? result.refusal.reason : '',
          )
        : []),
    ],
  }
}

export function compare(
  c: Case,
  exitCode: number,
  out: string,
  err: string,
  elapsed: number,
  checkOut: string | null = null,
  notes: readonly string[] = [],
): string[] {
  const diffs: string[] = [...notes]
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err !== c.expect.stderr)
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  if (c.check !== undefined && checkOut !== c.expect.check)
    diffs.push(`check: expected ${JSON.stringify(c.expect.check)}, got ${JSON.stringify(checkOut)}`)
  const bounds = c.expect.elapsed
  if (bounds !== undefined && (elapsed < bounds.min || elapsed > bounds.max))
    diffs.push(
      `elapsed: expected [${String(bounds.min)}, ${String(bounds.max)}], got ${elapsed.toFixed(3)}`,
    )
  return diffs
}
