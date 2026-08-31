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

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ImapFlow } from 'imapflow'
import { createTransport } from 'nodemailer'
import type { JsonValue } from '../kit/typescript/types.ts'

// This fake has no corpus case at all yet, and even once the email battery
// points at it, the battery cannot reach the two things that make it worth
// writing: run separation (two logins at one address, same account, different
// worlds) and the verbs no mirage client sends. Both are here.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const USER = 'integ@example.com'
const OTHER = 'alpha@example.com'
const RUN_A = 'runa'
const RUN_B = 'runb'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`mail selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

function detailOf(err: unknown): string {
  const text = (err as { responseText?: string }).responseText
  if (typeof text === 'string' && text !== '') return text
  return err instanceof Error ? err.message : String(err)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  http: string
  imapPort: number
  smtpPort: number
}

async function launch(extraArgs: string[] = []): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0', '--imap-port', '0', '--smtp-port', '0', ...extraArgs],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const lines = await new Promise<string[]>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const got = out.split('\n').filter((one) => one !== '')
      if (got.length >= 3) ok(got)
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  const at = (token: string): string =>
    (lines.find((one) => one.startsWith(`${token}=`)) ?? '').split('=').slice(1).join('=')
  const http = at('MAIL_URL')
  const imap = at('MAIL_IMAP_URL')
  const smtp = at('MAIL_SMTP_URL')
  check('the imap announce carries its own scheme', imap.startsWith('imap://'), imap)
  check('the smtp announce carries its own scheme', smtp.startsWith('smtp://'), smtp)
  return {
    child,
    http,
    imapPort: Number(new URL(imap).port),
    smtpPort: Number(new URL(smtp).port),
  }
}

async function reset(fake: Fake, run: string, tenant: string): Promise<number> {
  const r = await fetch(`${fake.http}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run, tenants: [tenant], fixture: 'v1' }),
  })
  return r.status
}

async function connect(fake: Fake, user: string, pass: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: '127.0.0.1',
    port: fake.imapPort,
    secure: false,
    auth: { user, pass },
    logger: false,
  })
  await client.connect()
  return client
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    check('reset seeds run a', (await reset(fake, RUN_A, 'integ')) === 200)
    check('reset seeds run b', (await reset(fake, RUN_B, 'integ')) === 200)
    check('reset seeds a second account', (await reset(fake, RUN_A, 'alpha')) === 200)

    // ---- a login the fake was never seeded for is refused, loudly
    const ghost = new ImapFlow({
      host: '127.0.0.1',
      port: fake.imapPort,
      secure: false,
      auth: { user: 'nobody@example.com', pass: RUN_A },
      logger: false,
    })
    let refused = ''
    try {
      await ghost.connect()
    } catch (err: unknown) {
      // imapflow reports a failed command as "Command failed" and keeps the
      // server's own words on `responseText`, so reading `message` alone tests
      // the client's wording rather than the fake's.
      refused = detailOf(err)
    }
    check('an unseeded account cannot log in', refused !== '', refused.slice(0, 80))
    // The alternative -- provisioning on first login -- makes a typo'd password
    // a fresh empty world where every read succeeds and holds nothing.
    check('and the refusal names the run', refused.includes(RUN_A), refused.slice(0, 120))

    // ---- a login from another domain is refused by name
    const foreign = new ImapFlow({
      host: '127.0.0.1',
      port: fake.imapPort,
      secure: false,
      auth: { user: 'integ@elsewhere.test', pass: RUN_A },
      logger: false,
    })
    let wrongDomain = ''
    try {
      await foreign.connect()
    } catch (err: unknown) {
      wrongDomain = detailOf(err)
    }
    check(
      'another domain is refused',
      wrongDomain.includes('this server serves @'),
      wrongDomain.slice(0, 100),
    )

    const a = await connect(fake, USER, RUN_A)
    try {
      // ---- LIST, and the mailboxes every account starts with
      const boxes = (await a.list()).map((one) => one.path)
      check(
        'INBOX and Sent exist without being created',
        boxes.includes('INBOX') && boxes.includes('Sent'),
        JSON.stringify(boxes),
      )
      // The manifest's own folders are made on demand while seeding.
      check('the manifest folders exist', boxes.includes('Archive'), JSON.stringify(boxes))

      const lock = await a.getMailboxLock('INBOX')
      let seeded: number[] = []
      try {
        // ---- SEARCH, the whole reason this is a parser
        seeded = (await a.search({}, { uid: true })) as number[]
        check('the fixture seeded INBOX', seeded.length >= 3, JSON.stringify(seeded))
        const unseen = (await a.search({ seen: false }, { uid: true })) as number[]
        check(
          'UNSEEN excludes the one flagged \\Seen',
          unseen.length === seeded.length - 1,
          JSON.stringify(unseen),
        )
        const fromLila = (await a.search({ from: 'lila@example.com' }, { uid: true })) as number[]
        check('FROM matches a header substring', fromLila.length === 1, JSON.stringify(fromLila))
        const subject = (await a.search({ subject: 'Budget' }, { uid: true })) as number[]
        check('SUBJECT is case-insensitive', subject.length === 1, JSON.stringify(subject))
        // The operators himalaya's DSL compiles to, which a key-at-a-time
        // matcher answers wrongly by ignoring them.
        const notLila = (await a.search(
          { not: { from: 'lila@example.com' } },
          { uid: true },
        )) as number[]
        check('NOT inverts', notLila.length === seeded.length - 1, JSON.stringify(notLila))
        const either = (await a.search(
          { or: [{ from: 'lila@example.com' }, { from: 'marcus@example.com' }] },
          { uid: true },
        )) as number[]
        check('OR unions', either.length === 2, JSON.stringify(either))

        // ---- FETCH: whole message, flags, uid, internaldate. No ENVELOPE and
        // no BODYSTRUCTURE anywhere, because every client here parses the MIME
        // itself.
        const first = seeded[0] ?? 0
        const msg = await a.fetchOne(
          String(first),
          { source: true, flags: true, uid: true, internalDate: true },
          { uid: true },
        )
        check('fetchOne answers', msg !== false, msg === false ? 'not found' : 'found')
        // A bare `*` is the highest uid in use, not the whole mailbox; matching
        // everything turned "touch the latest message" into "touch every one".
        const star: number[] = []
        for await (const one of a.fetch('*', { uid: true }, { uid: true })) star.push(one.uid)
        check(
          'a bare * selects only the last message',
          star.length === 1 && star[0] === Math.max(...seeded),
          JSON.stringify(star),
        )
        if (msg !== false) {
          const source = msg.source instanceof Buffer ? msg.source.toString('utf8') : ''
          check(
            'the source is the whole rfc822 message',
            source.startsWith('From: '),
            source.slice(0, 40),
          )
          check(
            'the source carries its MIME body',
            source.includes('Content-Transfer-Encoding: base64'),
            '',
          )
          eq('the uid comes back', msg.uid, first)
          check(
            'internalDate is the manifest Date',
            msg.internalDate instanceof Date,
            String(typeof msg.internalDate),
          )
        }

        // ---- STORE, and the flag it sets is what UNSEEN then reads
        await a.messageFlagsAdd(String(first), ['\\Seen'], { uid: true })
        const afterStore = (await a.search({ seen: false }, { uid: true })) as number[]
        check(
          'STORE +FLAGS is visible to SEARCH',
          afterStore.length === seeded.length - 2,
          JSON.stringify(afterStore),
        )

        // ---- COPY into another mailbox, which mints a NEW uid there
        await a.messageCopy(String(first), 'Sent', { uid: true })
      } finally {
        lock.release()
      }

      const sentLock = await a.getMailboxLock('Sent')
      try {
        const copied = (await a.search({}, { uid: true })) as number[]
        eq('COPY lands one message in Sent with uid 1', copied, [1])
      } finally {
        sentLock.release()
      }

      // ---- EXAMINE means READ-ONLY, and STORE against it is refused
      await a.mailboxOpen('INBOX', { readOnly: true })
      const roStore = await a.messageFlagsAdd('1:*', ['\\Flagged']).then(
        (ok) => ok,
        () => false,
      )
      check('EXAMINE refuses STORE', roStore === false, JSON.stringify(roStore))

      // ---- UIDVALIDITY moves forward when a name is remade, so a client
      // caching by (mailbox, uid) throws the dead mailbox's cache away
      await a.mailboxCreate('Scratch')
      const v1 = (await a.mailboxOpen('Scratch')).uidValidity
      await a.mailboxClose()
      await a.mailboxDelete('Scratch')
      await a.mailboxCreate('Scratch')
      const v2 = (await a.mailboxOpen('Scratch')).uidValidity
      await a.mailboxClose()
      await a.mailboxDelete('Scratch')
      check(
        'a remade mailbox moves UIDVALIDITY forward',
        v2 !== undefined && v1 !== undefined && v2 > v1,
        `${String(v1)} -> ${String(v2)}`,
      )

      // ---- APPEND, and the UID it reports back
      const appended = await a.append(
        'Sent',
        Buffer.from(
          'From: me@example.com\r\nTo: you@example.com\r\nSubject: hand written\r\n\r\nbody\r\n',
        ),
        ['\\Seen'],
        new Date('2026-02-02T00:00:00Z'),
      )
      // Not JSON.stringify: imapflow hands back `uidValidity` as a BigInt,
      // which JSON refuses to serialize.
      check(
        'APPEND reports its uid',
        appended !== false && appended.uid === 2,
        appended === false ? 'refused' : `uid ${String(appended.uid)}`,
      )

      // ---- EXPUNGE: \Deleted then removed, and the mailbox shrinks. BOTH
      // messages carry \Deleted, so `UID EXPUNGE 1` proves the uid set
      // narrows the sweep: the bare-EXPUNGE fallback would take uid 2 too.
      const del = await a.getMailboxLock('Sent')
      try {
        await a.messageFlagsAdd('1:2', ['\\Deleted'], { uid: true })
        await a.messageDelete('1', { uid: true })
        const left = (await a.search({}, { uid: true })) as number[]
        eq('UID EXPUNGE removes only its uid set', left, [2])
        const still = (await a.search({ deleted: true }, { uid: true })) as number[]
        eq('the excluded message keeps its \\Deleted flag', still, [2])
        await a.messageFlagsRemove('2', ['\\Deleted'], { uid: true })
      } finally {
        del.release()
      }

      // ---- CREATE and DELETE
      await a.mailboxCreate('Later')
      check(
        'CREATE adds a mailbox',
        (await a.list()).some((one) => one.path === 'Later'),
      )
      await a.mailboxDelete('Later')
      check('DELETE removes it', !(await a.list()).some((one) => one.path === 'Later'))

      // ---- the keystone: the SAME address in another run is another world
      const b = await connect(fake, USER, RUN_B)
      try {
        const otherLock = await b.getMailboxLock('Sent')
        try {
          const theirs = (await b.search({}, { uid: true })) as number[]
          eq('run b sees none of run a Sent mail', theirs, [])
        } finally {
          otherLock.release()
        }
      } finally {
        await b.logout()
      }

      // ---- SMTP refuses what LOGIN refuses: an unseeded run, and a name
      // the grammar rejects, so a typo'd password cannot become an empty
      // world that swallows sends and `..` never reaches a pool file name.
      const badPass = createTransport({
        host: '127.0.0.1',
        port: fake.smtpPort,
        secure: false,
        auth: { user: USER, pass: 'no-such-run' },
        tls: { rejectUnauthorized: false },
      })
      const refusedRun = await badPass.verify().then(
        () => '',
        (err: unknown) => detailOf(err),
      )
      badPass.close()
      check(
        'smtp refuses an unseeded run',
        refusedRun.includes('no such account'),
        refusedRun.slice(0, 100),
      )
      const badName = createTransport({
        host: '127.0.0.1',
        port: fake.smtpPort,
        secure: false,
        auth: { user: USER, pass: '../escape' },
        tls: { rejectUnauthorized: false },
      })
      const refusedName = await badName.verify().then(
        () => '',
        (err: unknown) => detailOf(err),
      )
      badName.close()
      check(
        'smtp refuses a name outside the grammar',
        refusedName.includes('invalid credentials'),
        refusedName.slice(0, 100),
      )

      // ---- SMTP delivers into the run its password names
      const transport = createTransport({
        host: '127.0.0.1',
        port: fake.smtpPort,
        secure: false,
        auth: { user: USER, pass: RUN_A },
        tls: { rejectUnauthorized: false },
      })
      await transport.sendMail({
        from: USER,
        to: OTHER,
        subject: 'delivered by smtp',
        text: 'hello from the fake',
      })
      transport.close()
      const alpha = await connect(fake, OTHER, RUN_A)
      try {
        const inbox = await alpha.getMailboxLock('INBOX')
        try {
          const got = (await alpha.search(
            { subject: 'delivered by smtp' },
            { uid: true },
          )) as number[]
          check(
            'SMTP filed the message into the recipient INBOX',
            got.length === 1,
            JSON.stringify(got),
          )
        } finally {
          inbox.release()
        }
      } finally {
        await alpha.logout()
      }
      // And it went to THAT run only.
      const alphaB = await connect(fake, USER, RUN_B)
      try {
        const inbox = await alphaB.getMailboxLock('INBOX')
        try {
          const got = (await alphaB.search(
            { subject: 'delivered by smtp' },
            { uid: true },
          )) as number[]
          eq('and run b never saw it', got, [])
        } finally {
          inbox.release()
        }
      } finally {
        await alphaB.logout()
      }
    } finally {
      await a.logout()
    }

    await manifestChecks()
    await mimeChecks()
    await accountChecks()
    await domainChecks()
    await portChecks()
    process.stdout.write(`mail selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

// SEARCH matches the message, not its transfer encoding. Probed against real
// GreenMail 2.1.3, which decodes for BODY and TEXT: this fake did not, and
// because every part the shared builder emits is base64, `BODY "forecast"`
// answered nothing for a message whose rendered body says forecast. An empty
// result is a legal answer to a search, so nothing upstream could tell it from
// a body that really did not match.
//
// The second half is the trap the first half sets: FETCH serves the RAW
// message and must keep the bytes that arrived, so the decoded view is a field
// of its own. Sharing one field made every fetched message arrive decoded and
// took 35 corpus cases with it.
async function mimeChecks(): Promise<void> {
  const fake = await launch()
  try {
    await fetch(`${fake.http}/_run/mime/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: ['integ'], fixture: 'v1', extras: { manifest: 'v1' } }),
    })
    const imap = new ImapFlow({
      host: '127.0.0.1',
      port: fake.imapPort,
      secure: false,
      auth: { user: 'integ@example.com', pass: 'mime' },
      logger: false,
    })
    await imap.connect()
    try {
      const box = await imap.getMailboxLock('INBOX')
      try {
        const body = await imap.search({ body: 'forecast' })
        check(
          'BODY matches the DECODED body',
          (body as number[]).length === 1,
          JSON.stringify(body),
        )
        const text = await imap.search({ body: 'parser' })
        check('and so does TEXT', (text as number[]).length === 1, JSON.stringify(text))
        // The base64 of "yesterday shipped..." -- a server that matched the
        // transferred octets would find this and a real one never does.
        const raw = await imap.search({ body: 'eWVzdGVy' })
        check(
          'the transfer encoding itself is not searchable',
          (raw as number[]).length === 0,
          JSON.stringify(raw),
        )
        const att = await imap.search({ body: 'travel' })
        check(
          "an attachment's text is part of the message",
          (att as number[]).length === 1,
          JSON.stringify(att),
        )
        // FETCH is the other half: raw bytes, still base64 on the wire.
        const one = await imap.fetchOne('1', { source: true })
        const source = one === false ? '' : String(one.source)
        check(
          'FETCH still serves the RAW message',
          source.includes('Content-Transfer-Encoding: base64') && !source.includes('please find'),
          source.slice(0, 80),
        )
      } finally {
        box.release()
      }
    } finally {
      await imap.logout()
    }
  } finally {
    fake.child.kill('SIGTERM')
  }
}

// An entry that names no account belongs to the PRIMARY account. Defaulting it
// to the tenant being seeded gave every extra account a copy of the primary's
// inbox, which reads as working and destroys the one thing the extra accounts
// exist to prove: that a CLI install bound to alpha cannot see integ's mail.
async function accountChecks(): Promise<void> {
  const fake = await launch()
  try {
    await fetch(`${fake.http}/_run/accts/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenants: ['integ', 'alpha', 'beta'],
        fixture: 'v1',
        extras: { manifest: 'v1' },
      }),
    })
    const subjectsFor = async (local: string): Promise<string[]> => {
      const imap = new ImapFlow({
        host: '127.0.0.1',
        port: fake.imapPort,
        secure: false,
        auth: { user: `${local}@example.com`, pass: 'accts' },
        logger: false,
      })
      await imap.connect()
      try {
        const box = await imap.getMailboxLock('INBOX')
        try {
          // Read the Subject off the raw source: this fake serves no ENVELOPE
          // (nor BODYSTRUCTURE), by design -- the one consumer that would need
          // it is a client this corpus does not have.
          const out: string[] = []
          for await (const msg of imap.fetch('1:*', { source: true })) {
            const line = String(msg.source)
              .split(/\r?\n/)
              .find((l) => l.toLowerCase().startsWith('subject:'))
            out.push(line === undefined ? '' : line.slice('subject:'.length).trim())
          }
          return out
        } finally {
          box.release()
        }
      } finally {
        await imap.logout()
      }
    }
    eq('the primary keeps the unaccounted mail', await subjectsFor('integ'), [
      'Q2 Budget Review',
      'Standup notes',
      'Server alert: worker-3',
    ])
    eq('and an extra account sees only its own', await subjectsFor('alpha'), [
      'Mail only alpha can see',
    ])
    eq('every extra account, not just the first', await subjectsFor('beta'), [
      'Mail only beta can see',
    ])
  } finally {
    fake.child.kill('SIGTERM')
  }
}

// The messages come from a manifest under the fixture root, and the ONLY
// tolerated way for it to be absent is for the file not to exist. A manifest
// that is present but malformed -- or a name with a typo, which from here is
// the same thing -- must fail the reset rather than seed an empty mailbox and
// report success, because every later assertion against an empty mailbox
// passes vacuously. Run against a fixture root of our own (item 5's
// `--fixture-root`), which is the only way to put a bad file in front of it.
async function manifestChecks(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mirage-mail-fixtures-'))
  mkdirSync(join(root, 'mail'), { recursive: true })
  mkdirSync(join(root, 'email'), { recursive: true })
  writeFileSync(join(root, 'mail', 'v1.json'), JSON.stringify({ mailboxes: [] }))
  writeFileSync(join(root, 'email', 'broken.json'), '{ not json')
  const fake = await launch(['--fixture-root', root])
  try {
    const base = fake.http
    const send = async (extras: Record<string, string>): Promise<number> => {
      const r = await fetch(`${base}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenants: ['integ'], fixture: 'v1', extras }),
      })
      return r.status
    }
    check(
      'a manifest that does not exist is a legal empty world',
      (await send({ manifest: 'absent' })) === 200,
    )
    const bad = await send({ manifest: 'broken' })
    check('a manifest that is present but malformed fails the reset', bad === 500, String(bad))
    // The name rides an unauthenticated /reset body, and `../mail/v1` names a
    // file that EXISTS here: joined verbatim it read outside fixtures/email.
    const out = await send({ manifest: '../mail/v1' })
    check('a manifest name that paths outside the root is refused', out === 400, String(out))
  } finally {
    fake.child.kill('SIGTERM')
  }
}

// `--mail-domain` moves the one served domain, and it is DECLARED to the
// launch preflight: the flag used to be refused as unexpected, so the
// documented override could never start the server. The value is checked at
// launch too, because a value no address can carry the domain of would start
// a server every login bounces off.
async function domainChecks(): Promise<void> {
  const fake = await launch(['--mail-domain', 'mcp.test'])
  try {
    check('a moved domain still seeds', (await reset(fake, RUN_A, 'integ')) === 200)
    const a = await connect(fake, 'integ@mcp.test', RUN_A)
    await a.logout()
    let stock = ''
    try {
      await connect(fake, 'integ@example.com', RUN_A)
    } catch (err) {
      stock = detailOf(err)
    }
    check(
      'the stock domain is refused once moved',
      stock.includes('this server serves @mcp.test'),
      stock,
    )
  } finally {
    fake.child.kill('SIGTERM')
  }
  let refused = ''
  try {
    const dead = await launch(['--mail-domain', 'not a domain'])
    dead.child.kill('SIGTERM')
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err)
  }
  check(
    'a value that is not a domain refuses the launch',
    refused.includes('takes a domain'),
    refused,
  )
}

// A launch that must die before announcing, spawned with EXACTLY these args:
// `launch` cannot say this, because it puts `--imap-port 0 --smtp-port 0`
// first and the scan reads a flag's FIRST occurrence. Announcing anything is
// the regression, so a stdout line resolves empty and fails the check.
async function dies(args: string[]): Promise<string> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0', ...args],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  return new Promise<string>((ok) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', () => {
      child.kill('SIGTERM')
      ok('')
    })
    child.on('exit', () => {
      ok(err)
    })
  })
}

// The kit's port scan is strict on the arm flags too: parseInt's tolerated
// suffix used to read `3025junk` as 3025, and a flag typed with no value
// silently took the fallback, so the process announced a healthy listener on
// a port the launch line never asked for.
async function portChecks(): Promise<void> {
  const junk = await dies(['--smtp-port', '3025junk'])
  check(
    'a port with a trailing suffix refuses the launch',
    junk.includes('must be a port number'),
    junk.slice(0, 80),
  )
  const bare = await dies(['--imap-port'])
  check(
    'a port flag with no value refuses the launch',
    bare.includes('requires a value'),
    bare.slice(0, 80),
  )
}

await main()
