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

import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { bindHost, checkName } from '../kit/typescript/index.ts'
import { queue } from './queue.ts'
import type { Runtime } from '../kit/typescript/index.ts'
import { DEFAULT_MAILBOXES, INBOX, mailDomain, splitAddress, type C } from './config.ts'
import { SearchError, inSet, searchMessages, tokenize, type SearchMsg } from './search.ts'
import {
  appendMessage,
  canonicalName,
  createMailbox,
  deleteMailbox,
  mailboxOf,
  mailboxesOf,
  messagesOf,
  removeMessage,
  setFlags,
  withSequence,
} from './store.ts'

// The capability line every client reads before it decides how to talk. LITERAL+
// matters: without it imapflow sends a synchronising literal and waits for the
// `+ ` continuation, and a fake that answered neither hung the connection.
// UIDPLUS is what makes APPEND report the UID it assigned, which the seeder
// needs to know what it just wrote.
const CAPABILITIES = 'IMAP4rev1 LITERAL+ UIDPLUS ENABLE ID NAMESPACE'

// The flags a mailbox advertises. \Recent is advertised but never set: this
// fake has no session-scoped arrival state and every consumer reads \Seen.
const FLAGS = '\\Answered \\Flagged \\Deleted \\Seen \\Draft'

type State = 'unauth' | 'auth' | 'selected'

interface Session {
  socket: Socket
  state: State
  tenant: string
  run: string
  mailbox: string
  // EXAMINE's promise: the mailbox was opened READ-ONLY and stays that way
  // until the next SELECT, so mutating verbs check this bit.
  readOnly: boolean
  // Set once the current command's literal has been read, so a line arriving
  // while a literal is outstanding is data rather than a command.
  pending: { need: number; chunks: Buffer[]; line: string } | null
}

function write(session: Session, line: string): void {
  session.socket.write(`${line}\r\n`)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// `05-Jan-2026 09:30:00 +0000`, which is the INTERNALDATE wire form. It is
// rendered in UTC with an explicit +0000 rather than in local time, because a
// golden that moves with the runner's timezone is not a golden.
export function internalDateOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return (
    `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()] ?? 'Jan'}-${String(d.getUTCFullYear())} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
  )
}

// The reverse, for APPEND's optional date argument.
export function parseInternalDate(raw: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
    raw,
  )
  if (m === null) return Number.NaN
  const month = MONTHS.findIndex((one) => one.toLowerCase() === (m[2] ?? '').toLowerCase())
  if (month === -1) return Number.NaN
  const sign = m[7] === '-' ? 1 : -1
  const offset = sign * (Number(m[8]) * 60 + Number(m[9])) * 60_000
  return (
    Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) + offset
  )
}

interface Command {
  tag: string
  name: string
  args: string[]
  literal: Buffer | null
}

// One command line, split into tag, verb and the rest. The rest keeps its
// quoting, because SEARCH needs the raw text and the other verbs want it
// tokenized; only the verb and tag are consumed here.
function parseCommand(line: string, literal: Buffer | null): Command | null {
  const trimmed = line.replace(/\r$/, '')
  const first = trimmed.indexOf(' ')
  if (first === -1) return null
  const tag = trimmed.slice(0, first)
  const rest = trimmed.slice(first + 1)
  const second = rest.indexOf(' ')
  const name = (second === -1 ? rest : rest.slice(0, second)).toUpperCase()
  const args = second === -1 ? [] : tokenize(rest.slice(second + 1))
  return { tag, name, args, literal }
}

// The argument text after the verb, unparsed. SEARCH is the reason: its keys
// are an expression, and re-joining tokenized words would lose the quoting that
// tells `FROM "a b"` from two keys.
function rawArgs(line: string, verb: string): string {
  const trimmed = line.replace(/\r$/, '')
  const at = trimmed.toUpperCase().indexOf(` ${verb} `)
  return at === -1 ? '' : trimmed.slice(at + verb.length + 2)
}

export function startImapServer(
  runtime: Runtime<C>,
  port: number,
): Promise<{
  server: Server
  port: number
  close: () => Promise<void>
}> {
  // Tracked so teardown can destroy them. `server.close()` stops new
  // connections and then WAITS for the open ones, and an IMAP client holds its
  // socket open by design, so without this the close callback never fires.
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    const session: Session = {
      socket,
      state: 'unauth',
      tenant: '',
      run: '',
      mailbox: '',
      readOnly: false,
      pending: null,
    }
    write(session, `* OK [CAPABILITY ${CAPABILITIES}] mirage mail fake ready`)
    let buffer = Buffer.alloc(0)
    // Set after a literal's body is consumed: the command's terminating CRLF
    // arrives AFTER the body, and left in the buffer it reads as an empty
    // command line and answers an unsolicited BAD.
    let swallow = false
    // Commands are serialized per CONNECTION as well as per run: a client that
    // pipelines two commands must not have the second one's reply interleave
    // with the first one's untagged lines.
    let chain: Promise<void> = Promise.resolve()
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (session.pending !== null) {
          const want = session.pending.need
          if (buffer.length < want) return
          const body = buffer.subarray(0, want)
          buffer = buffer.subarray(want)
          const held = session.pending
          session.pending = null
          swallow = true
          const line = held.line
          chain = chain.then(() => handle(runtime, session, line, body))
          continue
        }
        if (swallow) {
          if (buffer.length === 0) return
          if (buffer[0] === 0x0a) {
            buffer = buffer.subarray(1)
          } else if (buffer[0] === 0x0d) {
            if (buffer.length < 2) return
            if (buffer[1] === 0x0a) buffer = buffer.subarray(2)
          }
          swallow = false
          continue
        }
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        const line = buffer.subarray(0, nl).toString('utf8')
        buffer = buffer.subarray(nl + 1)
        const literal = /\{(\d+)(\+?)\}\r?$/.exec(line)
        if (literal !== null) {
          session.pending = { need: Number(literal[1]), chunks: [], line }
          // A synchronising literal (no `+`) needs the continuation before the
          // client will send anything. LITERAL+ is advertised, so most clients
          // send `{n+}` and never wait, but aioimaplib's APPEND does not.
          if (literal[2] !== '+') write(session, '+ ready for literal data')
          continue
        }
        chain = chain.then(() => handle(runtime, session, line, null))
      }
    })
    socket.on('error', () => {
      socket.destroy()
    })
  })
  return new Promise((resolve) => {
    server.listen(port, bindHost(), () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('imap: no port')
      resolve({
        server,
        port: address.port,
        close: async () => {
          // The destroy is what makes the close callback fire: without it
          // teardown runs to the client's own idle timeout, which made the
          // selftest take three minutes and would make a harness look hung.
          // `closeAllConnections` is http.Server's, not net.Server's, so
          // calling it here threw instead -- invisible while the only caller
          // was a signal handler on its way out of the process.
          await new Promise<void>((done) => {
            server.close(() => {
              done()
            })
            for (const socket of open) socket.destroy()
            open.clear()
          })
        },
      })
    })
  })
}

function db(runtime: Runtime<C>, session: Session): C {
  return runtime.pool.client(session.run)
}

async function handle(
  runtime: Runtime<C>,
  session: Session,
  line: string,
  literal: Buffer | null,
): Promise<void> {
  const cmd = parseCommand(line, literal)
  if (cmd === null) {
    write(session, '* BAD missing command')
    return
  }
  try {
    await dispatch(runtime, session, cmd, line)
  } catch (err: unknown) {
    // A protocol error is answered on the wire and never thrown out of the
    // connection: a fake that drops the socket on a bad key looks to the client
    // exactly like a server that crashed.
    const message = err instanceof Error ? err.message : String(err)
    write(session, `${cmd.tag} NO ${message}`)
  }
}

async function dispatch(
  runtime: Runtime<C>,
  session: Session,
  cmd: Command,
  line: string,
): Promise<void> {
  const { tag, name, args } = cmd
  if (name === 'CAPABILITY') {
    write(session, `* CAPABILITY ${CAPABILITIES}`)
    write(session, `${tag} OK CAPABILITY completed`)
    return
  }
  if (name === 'NOOP') {
    write(session, `${tag} OK NOOP completed`)
    return
  }
  if (name === 'LOGOUT') {
    write(session, '* BYE mirage mail fake signing off')
    write(session, `${tag} OK LOGOUT completed`)
    session.socket.end()
    return
  }
  if (name === 'ID') {
    write(session, '* ID ("name" "mirage-mail-fake")')
    write(session, `${tag} OK ID completed`)
    return
  }
  if (name === 'ENABLE') {
    write(session, `${tag} OK ENABLE completed`)
    return
  }
  if (name === 'NAMESPACE') {
    write(session, '* NAMESPACE (("" "/")) NIL NIL')
    write(session, `${tag} OK NAMESPACE completed`)
    return
  }
  if (name === 'LOGIN') {
    await login(runtime, session, tag, args)
    return
  }
  if (session.state === 'unauth') {
    write(session, `${tag} NO command ${name} illegal in state NOAUTH`)
    return
  }
  if (name === 'LIST' || name === 'LSUB') {
    await list(runtime, session, tag)
    return
  }
  if (name === 'STATUS') {
    await status(runtime, session, tag, args)
    return
  }
  if (name === 'CREATE') {
    await create(runtime, session, tag, args)
    return
  }
  if (name === 'DELETE') {
    await remove(runtime, session, tag, args)
    return
  }
  if (name === 'SELECT' || name === 'EXAMINE') {
    await select(runtime, session, tag, args, name === 'EXAMINE')
    return
  }
  if (name === 'APPEND') {
    await append(runtime, session, tag, args, cmd.literal)
    return
  }
  if (name === 'CLOSE') {
    // RFC 3501: CLOSE after EXAMINE returns to authenticated WITHOUT the
    // implicit expunge, because read-only means the permanent state holds.
    if (session.state === 'selected' && !session.readOnly) {
      await expungeDeleted(runtime, session)
    }
    session.state = 'auth'
    session.mailbox = ''
    write(session, `${tag} OK CLOSE completed`)
    return
  }
  if (name === 'UNSELECT') {
    session.state = 'auth'
    session.mailbox = ''
    write(session, `${tag} OK UNSELECT completed`)
    return
  }
  const uidMode = name === 'UID'
  const verb = uidMode ? (args[0] ?? '').toUpperCase() : name
  if (
    session.state !== 'selected' &&
    ['SEARCH', 'FETCH', 'STORE', 'COPY', 'EXPUNGE'].includes(verb)
  ) {
    write(session, `${tag} NO command ${verb} illegal in state AUTH`)
    return
  }
  // EXAMINE announced READ-ONLY, and RFC 3501 means it: no change to the
  // mailbox's permanent state is permitted. COPY stays legal because it
  // writes the target mailbox, not the selected one.
  if (session.state === 'selected' && session.readOnly && ['STORE', 'EXPUNGE'].includes(verb)) {
    write(session, `${tag} NO ${verb} refused: mailbox is opened READ-ONLY`)
    return
  }
  if (verb === 'SEARCH') {
    await search(runtime, session, tag, rawArgs(line, uidMode ? 'SEARCH' : name), uidMode)
    return
  }
  if (verb === 'FETCH') {
    await fetch(runtime, session, tag, uidMode ? args.slice(1) : args, uidMode)
    return
  }
  if (verb === 'STORE') {
    await store(runtime, session, tag, uidMode ? args.slice(1) : args, uidMode)
    return
  }
  if (verb === 'COPY') {
    await copy(runtime, session, tag, uidMode ? args.slice(1) : args, uidMode)
    return
  }
  if (verb === 'EXPUNGE') {
    // RFC 4315: UID EXPUNGE removes only the \Deleted messages its uid set
    // names, and the set is REQUIRED; a bare EXPUNGE removes them all.
    const uidSet = args[1] ?? ''
    if (uidMode && uidSet === '') {
      write(session, `${tag} BAD UID EXPUNGE takes a uid set`)
      return
    }
    await expungeDeleted(runtime, session, uidMode ? uidSet : null)
    write(session, `${tag} OK EXPUNGE completed`)
    return
  }
  write(session, `${tag} BAD unsupported command ${name}`)
}

// The whole point of this fake, in one function. The USERNAME is the tenant and
// the PASSWORD is the run, so two runs log in at ONE address as ONE account and
// get two mailboxes. That works only because the password is harness-side on
// both arms and appears in no task text: nothing the agent does can observe it,
// so nothing it does can depend on which run it is in.
//
// An account with no mailboxes in this run is REFUSED rather than provisioned.
// Provisioning would make a typo'd password a fresh empty world that answers
// every command successfully and holds nothing, which is the failure mode a
// harness cannot see: every read succeeds and every assertion is vacuous.
async function login(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
): Promise<void> {
  const user = args[0] ?? ''
  const pass = args[1] ?? ''
  if (user === '' || pass === '') {
    write(session, `${tag} BAD LOGIN takes a username and a password`)
    return
  }
  const address = splitAddress(user)
  const domain = mailDomain()
  if (address === null || address.domain !== domain.toLowerCase()) {
    write(
      session,
      `${tag} NO [AUTHENTICATIONFAILED] this server serves @${domain} only, not ${user}`,
    )
    return
  }
  let run: string
  let tenant: string
  try {
    run = checkName('run', pass)
    tenant = checkName('tenant', address.local)
  } catch {
    write(session, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`)
    return
  }
  session.run = run
  session.tenant = tenant
  const boxes = await mailboxesOf(db(runtime, session), tenant)
  if (boxes.length === 0) {
    session.run = ''
    session.tenant = ''
    write(
      session,
      `${tag} NO [AUTHENTICATIONFAILED] no account ${user} in run ${run}; ` +
        'seed it with POST /reset first',
    )
    return
  }
  session.state = 'auth'
  write(session, `${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed`)
}

function quoted(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function list(runtime: Runtime<C>, session: Session, tag: string): Promise<void> {
  for (const box of await mailboxesOf(db(runtime, session), session.tenant)) {
    write(session, `* LIST (\\HasNoChildren) "/" ${quoted(box.name)}`)
  }
  write(session, `${tag} OK LIST completed`)
}

async function status(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
): Promise<void> {
  const name = canonicalName(args[0] ?? '')
  const box = await mailboxOf(db(runtime, session), session.tenant, name)
  if (box === null) {
    write(session, `${tag} NO [TRYCREATE] no such mailbox`)
    return
  }
  const rows = await messagesOf(db(runtime, session), session.tenant, name)
  const unseen = rows.filter((one) => !one.flags.split(' ').includes('\\Seen')).length
  const values: Record<string, number> = {
    MESSAGES: rows.length,
    RECENT: 0,
    UIDNEXT: box.uidNext,
    UIDVALIDITY: box.uidValidity,
    UNSEEN: unseen,
  }
  const wanted = args.filter((one) => one in values)
  const asked = wanted.length > 0 ? wanted : Object.keys(values)
  const rendered = asked.map((k) => `${k} ${String(values[k] ?? 0)}`).join(' ')
  write(session, `* STATUS ${quoted(name)} (${rendered})`)
  write(session, `${tag} OK STATUS completed`)
}

async function create(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
): Promise<void> {
  const name = canonicalName(args[0] ?? '')
  await queue.enqueue(session.run, async () => {
    if ((await mailboxOf(db(runtime, session), session.tenant, name)) !== null) {
      write(session, `${tag} NO mailbox already exists`)
      return
    }
    await createMailbox(db(runtime, session), session.tenant, name)
    write(session, `${tag} OK CREATE completed`)
  })
}

async function remove(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
): Promise<void> {
  const name = canonicalName(args[0] ?? '')
  if (name === INBOX) {
    write(session, `${tag} NO cannot delete INBOX`)
    return
  }
  await queue.enqueue(session.run, async () => {
    if ((await mailboxOf(db(runtime, session), session.tenant, name)) === null) {
      write(session, `${tag} NO no such mailbox`)
      return
    }
    await deleteMailbox(db(runtime, session), session.tenant, name)
    if (session.mailbox === name) {
      session.state = 'auth'
      session.mailbox = ''
    }
    write(session, `${tag} OK DELETE completed`)
  })
}

async function select(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
  readOnly: boolean,
): Promise<void> {
  const name = canonicalName(args[0] ?? '')
  const box = await mailboxOf(db(runtime, session), session.tenant, name)
  if (box === null) {
    // The state is left where it was. A SELECT that fails and still moves the
    // session to `selected` makes the NEXT command answer against whatever was
    // selected before, which reads as the mailbox having the wrong contents.
    write(session, `${tag} NO [TRYCREATE] no such mailbox`)
    return
  }
  const rows = await messagesOf(db(runtime, session), session.tenant, name)
  write(session, `* FLAGS (${FLAGS})`)
  write(session, `* OK [PERMANENTFLAGS (${FLAGS} \\*)] flags permitted`)
  write(session, `* ${String(rows.length)} EXISTS`)
  write(session, '* 0 RECENT')
  write(session, `* OK [UIDVALIDITY ${String(box.uidValidity)}] uid validity`)
  write(session, `* OK [UIDNEXT ${String(box.uidNext)}] next uid`)
  session.state = 'selected'
  session.mailbox = name
  session.readOnly = readOnly
  write(session, `${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] SELECT completed`)
}

async function loaded(runtime: Runtime<C>, session: Session): Promise<SearchMsg[]> {
  return withSequence(await messagesOf(db(runtime, session), session.tenant, session.mailbox))
}

async function search(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  raw: string,
  uidMode: boolean,
): Promise<void> {
  let hits: SearchMsg[]
  try {
    hits = searchMessages(raw, await loaded(runtime, session))
  } catch (err: unknown) {
    if (!(err instanceof SearchError)) throw err
    write(session, `${tag} BAD ${err.message}`)
    return
  }
  const ids = hits.map((one) => String(uidMode ? one.uid : one.seq))
  write(session, `* SEARCH${ids.length === 0 ? '' : ` ${ids.join(' ')}`}`)
  write(session, `${tag} OK SEARCH completed`)
}

// The FETCH items every consumer here asks for, and no more. There is no
// ENVELOPE and no BODYSTRUCTURE on purpose: all three clients fetch the whole
// message and parse the MIME themselves, so implementing the structured forms
// would be inventing a second, unexercised rendering of the same bytes.
function fetchItem(item: string, msg: SearchMsg): string | null {
  const key = item.toUpperCase()
  if (key === 'UID') return `UID ${String(msg.uid)}`
  if (key === 'FLAGS') return `FLAGS (${msg.flags.join(' ')})`
  if (key === 'INTERNALDATE') return `INTERNALDATE "${internalDateOf(msg.internalDate)}"`
  if (key === 'RFC822.SIZE') return `RFC822.SIZE ${String(msg.source.length)}`
  return null
}

const BODY_ITEM = /^(BODY(?:\.PEEK)?\[\]|RFC822(?:\.TEXT)?)$/i

// The value a bare `*` in a sequence set resolves to (RFC 3501: the largest
// number in use), in whichever numbering the command runs under.
function highest(rows: { seq: number; uid: number }[], uidMode: boolean): number {
  return rows.reduce((top, one) => Math.max(top, uidMode ? one.uid : one.seq), 0)
}

async function fetch(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
  uidMode: boolean,
): Promise<void> {
  const set = args[0] ?? ''
  const items = args.slice(1).filter((one) => one !== '(' && one !== ')')
  const rows = await loaded(runtime, session)
  const top = highest(rows, uidMode)
  const wanted = rows.filter((one) => inSet(set, uidMode ? one.uid : one.seq, top))
  // A UID FETCH always reports the UID even when the client did not ask, which
  // is RFC 3501's own rule and what lets imapflow match a response to a request.
  const asked =
    uidMode && !items.some((one) => one.toUpperCase() === 'UID') ? ['UID', ...items] : items
  for (const msg of wanted) {
    const parts: string[] = []
    let body: Buffer | null = null
    let bodyKey = ''
    for (const item of asked) {
      const simple = fetchItem(item, msg)
      if (simple !== null) {
        parts.push(simple)
        continue
      }
      if (BODY_ITEM.test(item)) {
        bodyKey = item.toUpperCase().startsWith('RFC822') ? 'RFC822' : 'BODY[]'
        body = msg.source
        continue
      }
      write(session, `${tag} BAD unsupported fetch item ${item}`)
      return
    }
    // The literal goes LAST and its length prefix is written on the same line
    // as everything before it, because a client reads exactly `{n}` bytes and
    // then keeps parsing the same response: anything emitted after the literal
    // lands where a naive parser is not looking. The python client orders its
    // request the same way for the same reason.
    if (body === null) {
      write(session, `* ${String(msg.seq)} FETCH (${parts.join(' ')})`)
      continue
    }
    const head = parts.length === 0 ? '' : `${parts.join(' ')} `
    session.socket.write(
      `* ${String(msg.seq)} FETCH (${head}${bodyKey} {${String(body.length)}}\r\n`,
    )
    session.socket.write(body)
    session.socket.write(')\r\n')
  }
  write(session, `${tag} OK FETCH completed`)
}

const FLAG_OPS = /^([+-]?)FLAGS(\.SILENT)?$/i

async function store(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
  uidMode: boolean,
): Promise<void> {
  const set = args[0] ?? ''
  const op = FLAG_OPS.exec(args[1] ?? '')
  if (op === null) {
    write(session, `${tag} BAD unsupported store item ${args[1] ?? ''}`)
    return
  }
  const silent = op[2] !== undefined
  const given = args.slice(2).filter((one) => one !== '(' && one !== ')')
  await queue.enqueue(session.run, async () => {
    const rows = await loaded(runtime, session)
    const top = highest(rows, uidMode)
    for (const msg of rows) {
      if (!inSet(set, uidMode ? msg.uid : msg.seq, top)) continue
      const before = new Set(msg.flags)
      if (op[1] === '+') for (const f of given) before.add(f)
      else if (op[1] === '-') for (const f of given) before.delete(f)
      else {
        before.clear()
        for (const f of given) before.add(f)
      }
      const next = [...before]
      await setFlags(db(runtime, session), session.tenant, session.mailbox, msg.uid, next)
      if (!silent) {
        write(
          session,
          `* ${String(msg.seq)} FETCH (${uidMode ? `UID ${String(msg.uid)} ` : ''}FLAGS (${next.join(' ')}))`,
        )
      }
    }
    write(session, `${tag} OK STORE completed`)
  })
}

async function copy(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
  uidMode: boolean,
): Promise<void> {
  const set = args[0] ?? ''
  const target = canonicalName(args[1] ?? '')
  await queue.enqueue(session.run, async () => {
    if ((await mailboxOf(db(runtime, session), session.tenant, target)) === null) {
      write(session, `${tag} NO [TRYCREATE] no such mailbox`)
      return
    }
    const rows = await loaded(runtime, session)
    const top = highest(rows, uidMode)
    for (const msg of rows) {
      if (!inSet(set, uidMode ? msg.uid : msg.seq, top)) continue
      await appendMessage(
        db(runtime, session),
        session.tenant,
        target,
        msg.source,
        msg.flags,
        msg.internalDate,
      )
    }
    write(session, `${tag} OK COPY completed`)
  })
}

async function append(
  runtime: Runtime<C>,
  session: Session,
  tag: string,
  args: string[],
  literal: Buffer | null,
): Promise<void> {
  if (literal === null) {
    write(session, `${tag} BAD APPEND needs a literal`)
    return
  }
  const mailbox = canonicalName(args[0] ?? '')
  // Between the mailbox and the literal come an optional flag list and an
  // optional date, in that order and either or both absent. They are told
  // apart by shape rather than by position: a flag begins with a backslash and
  // a date does not.
  const rest = args.slice(1).filter((one) => one !== '(' && one !== ')' && !one.startsWith('{'))
  const flags = rest.filter((one) => one.startsWith('\\'))
  const dated = rest.find((one) => !one.startsWith('\\') && /^\d/.test(one))
  const when = dated === undefined ? Number.NaN : parseInternalDate(dated)
  await queue.enqueue(session.run, async () => {
    const box = await mailboxOf(db(runtime, session), session.tenant, mailbox)
    if (box === null) {
      write(session, `${tag} NO [TRYCREATE] no such mailbox`)
      return
    }
    const uid = await appendMessage(
      db(runtime, session),
      session.tenant,
      mailbox,
      literal,
      flags,
      Number.isNaN(when) ? runtime.state(session.run).of(session.tenant).clock.nowMs() : when,
    )
    // UIDPLUS, which is why it is advertised: the seeder needs to know what UID
    // it just wrote without listing the mailbox again.
    write(
      session,
      `${tag} OK [APPENDUID ${String(box.uidValidity)} ${String(uid)}] APPEND completed`,
    )
  })
}

// EXPUNGE removes every \Deleted message and reports each one by SEQUENCE
// NUMBER, highest first. Highest first is not a detail: each report renumbers
// the messages after it, so ascending order tells the client to remove the
// wrong ones. A UID EXPUNGE narrows the sweep to its uid set, so a \Deleted
// message the client deliberately left out survives; null means the bare
// verb (and CLOSE's implicit sweep), which spares nothing.
async function expungeDeleted(
  runtime: Runtime<C>,
  session: Session,
  uidSet: string | null = null,
): Promise<void> {
  await queue.enqueue(session.run, async () => {
    const rows = await loaded(runtime, session)
    const top = highest(rows, true)
    const doomed = rows.filter(
      (one) => one.flags.includes('\\Deleted') && (uidSet === null || inSet(uidSet, one.uid, top)),
    )
    for (const msg of [...doomed].reverse()) {
      await removeMessage(db(runtime, session), session.tenant, session.mailbox, msg.uid)
      write(session, `* ${String(msg.seq)} EXPUNGE`)
    }
  })
}

export { DEFAULT_MAILBOXES }
