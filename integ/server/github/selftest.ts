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

import { searchConformance } from './search_conformance.ts'
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'

// The routes the corpus does not reach, or cannot exercise fully, because the
// gh battery drives the porcelain against a one-repository fixture. A client
// that BUILDS history calls `POST /git/trees` then `POST /git/commits`, which is
// the path a fixture uses to pin a commit's own author and date; a grader reads
// an issue's comments back; repository search must preserve owner scope;
// and code search's scope rules need files under several owners and a
// mixed-case name, which the `cli` fixture does not hold.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-github'
const REPO = 'integ/repo-v1'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`github selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

const HEADERS = {
  'x-mirage-tenant': TENANT,
  authorization: 'token integ',
  'content-type': 'application/json',
}

async function post(url: string, body: JsonValue): Promise<{ status: number; body: JsonValue }> {
  const r = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as JsonValue }
}

async function get(url: string): Promise<JsonValue> {
  const r = await fetch(url, { headers: HEADERS })
  return (await r.json()) as JsonValue
}

function field(body: JsonValue, key: string): JsonValue {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? ((body as Record<string, JsonValue>)[key] ?? null)
    : null
}

// One staged tree holding one file, which is what a commit needs to exist.
async function stage(at: string, path: string, content: string): Promise<string> {
  const tree = await post(`${at}/repos/${REPO}/git/trees`, {
    tree: [{ path, mode: '100644', type: 'blob', content }],
  })
  return String(field(tree.body, 'sha') ?? '')
}

const AUTHOR = { name: 'Dana Wu', email: 'dana@example.com', date: '2025-09-02T09:00:00+08:00' }

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    const reset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- `{ref}:{dir}` lists one directory, as GitHub's rev syntax does; the
    // point lookup sends it percent-encoded as one segment, and python's
    // client sends the colon raw
    const shallow = async (segment: string): Promise<{ status: number; body: JsonValue }> => {
      const r = await fetch(`${at}/repos/${REPO}/git/trees/${segment}`, { headers: HEADERS })
      return { status: r.status, body: (await r.json()) as JsonValue }
    }
    // docs/vendored is a submodule: GitHub lists a gitlink in a tree, and the
    // client is what drops it.
    const names = (body: JsonValue): JsonValue[] =>
      (field(body, 'tree') as JsonValue[]).map((row) => field(row, 'path'))
    const docs = await shallow('main%3Adocs')
    eq('an encoded ref:dir lists that directory', names(docs.body), [
      'architecture.md',
      'contributing.md',
      'release.md',
      'vendored',
    ])
    eq('a raw colon lists the same rows', names((await shallow('main:docs')).body), [
      'architecture.md',
      'contributing.md',
      'release.md',
      'vendored',
    ])
    eq(
      'an encoded slash reaches a nested directory',
      names((await shallow('main%3Asrc%2Fcache')).body).length,
      9,
    )
    eq('a path through a file is 422', (await shallow('main%3AREADME.md')).status, 422)
    eq('a missing directory is 404', (await shallow('main%3Anope')).status, 404)
    eq('an unknown ref is 404', (await shallow('gone%3Adocs')).status, 404)
    const whole = await get(`${at}/repos/${REPO}/git/trees/main?recursive=1`)
    const wholeRow = (field(whole, 'tree') as JsonValue[]).find(
      (row) => field(row, 'path') === 'docs/release.md',
    )
    const pointRow = (field(docs.body, 'tree') as JsonValue[]).find(
      (row) => field(row, 'path') === 'release.md',
    )
    eq(
      "a listed row carries the recursive tree row's sha",
      field(pointRow ?? null, 'sha'),
      field(wholeRow ?? null, 'sha'),
    )
    check('vanilla gh search matches Mirage', (await searchConformance(at)) > 0)

    // ---- an author the caller states is the author the fake keeps
    const t1 = await stage(at, 'tasks/one.md', '# one\n')
    const made = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task one',
      tree: t1,
      author: AUTHOR,
    })
    check('a commit is created', made.status === 201, String(made.status))
    eq('the response echoes the author verbatim', field(made.body, 'author'), AUTHOR)

    // The offset is the point. Normalizing it to UTC would answer the same
    // instant spelled differently, and a fixture that pinned +08:00 would read
    // back as something it did not write.
    const author = field(made.body, 'author')
    check(
      'the pinned offset survives',
      String(field(author, 'date')) === '2025-09-02T09:00:00+08:00',
      String(field(author, 'date')),
    )
    eq('a missing committer defaults to the author', field(made.body, 'committer'), AUTHOR)

    // ---- and it survives the round trip, which is what a reader sees
    const sha = String(field(made.body, 'sha') ?? '')
    const read = await get(`${at}/repos/${REPO}/git/commits/${sha}`)
    eq('GET /git/commits/:sha reports the author', field(read, 'author'), AUTHOR)
    eq('and the committer', field(read, 'committer'), AUTHOR)

    // ---- a commit exists before any ref names it, and until one does it is
    // on no branch's history, which is what "dangling" means: readable by sha,
    // absent from every list.
    const beforeAttach = await get(`${at}/repos/${REPO}/commits`)
    check(
      'a commit no ref names is not on a branch',
      Array.isArray(beforeAttach) && !beforeAttach.some((c) => String(field(c, 'sha')) === sha),
      sha,
    )

    // ---- the list endpoint, which is what "most recent commits" reads, once
    // the ref has been pointed at the commit
    const trunk = String(field(await get(`${at}/repos/${REPO}`), 'default_branch'))
    const attach = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha }),
    })
    check('the default ref takes the commit', attach.status === 200, String(attach.status))
    const listed = await get(`${at}/repos/${REPO}/commits`)
    const top = Array.isArray(listed) ? (listed[0] ?? null) : null
    eq('the commit list carries the author', field(field(top, 'commit'), 'author'), AUTHOR)

    // ---- a committer distinct from the author is kept distinct
    const t2 = await stage(at, 'tasks/two.md', '# two\n')
    const two = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task two',
      tree: t2,
      author: AUTHOR,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-03T11:30:00+08:00' },
    })
    eq('a distinct committer is kept', field(two.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-03T11:30:00+08:00',
    })
    eq('and does not overwrite the author', field(two.body, 'author'), AUTHOR)

    // ---- an author naming only a date still gets a whole person
    const t3 = await stage(at, 'tasks/three.md', '# three\n')
    const dated = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task three',
      tree: t3,
      author: { date: '2025-09-04T08:00:00Z' },
    })
    eq('a date-only author is filled out', field(dated.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2025-09-04T08:00:00Z',
    })

    // ---- a commit that names nobody is unchanged, which is what the goldens
    // record: the author blocks are absent, not empty.
    const t4 = await stage(at, 'tasks/four.md', '# four\n')
    const bare = await post(`${at}/repos/${REPO}/git/commits`, { message: 'Add four', tree: t4 })
    check('a commit naming nobody has no author', field(bare.body, 'author') === null, 'absent')
    check(
      'and no committer',
      field(bare.body, 'committer') === null,
      String(field(bare.body, 'committer')),
    )

    // ---- a malformed author is refused rather than read as absent
    const t5 = await stage(at, 'tasks/five.md', '# five\n')
    const bad = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      author: 'Dana Wu <dana@example.com>',
    })
    check('a non-object author is 422', bad.status === 422, String(bad.status))
    const badc = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      committer: ['Dana Wu'],
    })
    check('a non-object committer is 422', badc.status === 422, String(badc.status))

    // ---- a committer without an author keeps the committer, and the author
    // fills with the endpoint's default identity rather than vanishing
    const tSolo = await stage(at, 'tasks/solo.md', '# solo\n')
    const solo = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add solo',
      tree: tSolo,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-05T09:15:00+08:00' },
    })
    eq('a committer alone is kept', field(solo.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-05T09:15:00+08:00',
    })
    eq('and the author fills with the default identity', field(solo.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2026-01-01T00:00:00Z',
    })

    // ---- pointing a ref at a commit is what puts it on that branch's
    // history: a client that builds history stages a tree, creates the
    // commit, and PATCHes the ref, and the branch's commit list has to grow
    // by exactly that commit. The move is a move, not a copy: a commit a ref
    // took to a branch does not stay on the default branch's history.
    const mainBefore = await get(`${at}/repos/${REPO}/commits`)
    const mainCount = Array.isArray(mainBefore) ? mainBefore.length : 0
    const made6 = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-1',
      sha: '',
    })
    check('a branch is created', made6.status === 201, String(made6.status))
    const branchBefore = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    const branchCount = Array.isArray(branchBefore) ? branchBefore.length : 0
    const t6 = await stage(at, 'tasks/six.md', '# six\n')
    const six = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task six',
      tree: t6,
      author: AUTHOR,
    })
    const sha6 = String(field(six.body, 'sha') ?? '')
    const moved = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('the ref moves', moved.status === 200, String(moved.status))
    const branchAfter = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    const rows = Array.isArray(branchAfter) ? branchAfter : []
    check(
      'the branch history grows by one',
      rows.length === branchCount + 1,
      `got ${String(rows.length)} want ${String(branchCount + 1)}`,
    )
    check('and its head is the commit the ref took', String(field(rows[0] ?? null, 'sha')) === sha6)
    eq(
      'with the message the commit stated',
      field(field(rows[0] ?? null, 'commit'), 'message'),
      'Add task six',
    )
    eq(
      'and the author it stated',
      field(field(field(rows[0] ?? null, 'commit'), 'author'), 'date'),
      AUTHOR.date,
    )
    const mainAfter = await get(`${at}/repos/${REPO}/commits`)
    check(
      'the default branch does not keep it',
      Array.isArray(mainAfter) && mainAfter.length === mainCount,
      `got ${String(Array.isArray(mainAfter) ? mainAfter.length : -1)} want ${String(mainCount)}`,
    )
    const read6 = await get(`${at}/repos/${REPO}/git/commits/${sha6}`)
    eq('GET /git/commits/:sha still answers after the move', field(read6, 'sha'), sha6)

    // ---- the moved commit freed its sequence on the default branch, so a
    // later commit reusing that sequence AND the message must still get its
    // own sha, or a ref update resolving the sha publishes the wrong tree.
    const t7 = await stage(at, 'tasks/seven.md', '# seven\n')
    const seven = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task six',
      tree: t7,
    })
    check(
      'a same-message commit after the move gets its own sha',
      String(field(seven.body, 'sha')) !== sha6,
      sha6,
    )

    // ---- a second ref pointing at the same commit shares it: git commits
    // are reachable from many refs, so attaching one to another branch copies
    // it onto that history rather than stealing it from the first.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-2', sha: '' })
    const shared = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-2`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('a second ref takes the same commit', shared.status === 200, String(shared.status))
    const firstList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'the first branch keeps it',
      Array.isArray(firstList) && String(field(firstList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(firstList) ? firstList[0] : null) ?? null, 'sha')),
    )
    const secondList = await get(`${at}/repos/${REPO}/commits?sha=task-2`)
    check(
      'and the second branch gains it',
      Array.isArray(secondList) && String(field(secondList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(secondList) ? secondList[0] : null) ?? null, 'sha')),
    )

    // ---- resetting a branch to an older commit is a forced update: refused
    // without `force`, and with it the requested commit becomes the head and
    // the discarded one leaves the branch's history.
    const t8 = await stage(at, 'tasks/eight.md', '# eight\n')
    const eight = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task eight',
      tree: t8,
      parents: [sha6],
    })
    const sha8 = String(field(eight.body, 'sha') ?? '')
    const advance = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha8 }),
    })
    check(
      'a commit stating its parent advances the ref unforced',
      advance.status === 200,
      String(advance.status),
    )
    const soft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('a backward update without force is refused', soft.status === 422, String(soft.status))
    const heldRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-1`)
    eq('and the head is unchanged', field(field(heldRef, 'object'), 'sha'), sha8)
    const forced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6, force: true }),
    })
    check('a forced backward update lands', forced.status === 200, String(forced.status))
    const resetRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-1`)
    eq('the head is the requested commit', field(field(resetRef, 'object'), 'sha'), sha6)
    const resetList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'and the discarded commit left the history',
      Array.isArray(resetList) && !resetList.some((c) => String(field(c, 'sha')) === sha8),
      sha8,
    )
    // Abandoned, not destroyed: nothing points at it, and it still answers,
    // which is what the vendor does with a dangling commit.
    const dangling = await get(`${at}/repos/${REPO}/git/commits/${sha8}`)
    eq('the abandoned commit is still readable by sha', field(dangling, 'sha'), sha8)

    // ---- two commits telling the same tree and message apart only by their
    // author are two commits, even when a move freed the first one's sequence.
    const t9 = await stage(at, 'tasks/nine.md', '# nine\n')
    const nineA = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task nine',
      tree: t9,
      author: AUTHOR,
    })
    const sha9a = String(field(nineA.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-3', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-3`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha9a }),
    })
    const nineB = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task nine',
      tree: t9,
      author: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-06T10:00:00+08:00' },
    })
    check(
      'a same-tree same-message commit by another author gets its own sha',
      String(field(nineB.body, 'sha')) !== sha9a,
      sha9a,
    )

    // ---- a reset is a reset even when the requested commit's row lives on
    // another branch: it is older than the branch's commits, so the update is
    // not a fast forward, and forcing it discards the newer commits without
    // taking anything from the branch that holds the requested one.
    const tK = await stage(at, 'tasks/ten.md', '# ten\n')
    const ten = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task ten',
      tree: tK,
    })
    const shaK = String(field(ten.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-4', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaK }),
    })
    const crossSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check(
      'a cross-branch backward update without force is refused',
      crossSoft.status === 422,
      String(crossSoft.status),
    )
    const crossForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6, force: true }),
    })
    check('and lands when forced', crossForced.status === 200, String(crossForced.status))
    const crossRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-4`)
    eq(
      'the head is the requested commit after the reset',
      field(field(crossRef, 'object'), 'sha'),
      sha6,
    )
    const crossList = await get(`${at}/repos/${REPO}/commits?sha=task-4`)
    check(
      'the newer commit left the reset branch',
      Array.isArray(crossList) && !crossList.some((c) => String(field(c, 'sha')) === shaK),
      shaK,
    )
    const donorList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'and the branch holding the commit keeps it',
      Array.isArray(donorList) && String(field(donorList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(donorList) ? donorList[0] : null) ?? null, 'sha')),
    )

    // ---- a client may prepare several commits before touching any ref. Each
    // states the one it builds on, so the two form a chain and attaching them
    // in turn is an ordinary fast forward, however long the ref sat still.
    const trunkHead = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`), 'object'), 'sha'),
    )
    const tw = await stage(at, 'tasks/twelve.md', '# twelve\n')
    const twelve = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task twelve',
      tree: tw,
      parents: [trunkHead],
    })
    const shaTw = String(field(twelve.body, 'sha') ?? '')
    const th = await stage(at, 'tasks/thirteen.md', '# thirteen\n')
    const thirteen = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task thirteen',
      tree: th,
      parents: [shaTw],
    })
    const shaTh = String(field(thirteen.body, 'sha') ?? '')
    const parked1 = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaTw }),
    })
    check(
      'attaching a prepared commit needs no force with another prepared above',
      parked1.status === 200,
      String(parked1.status),
    )
    const trunkRef1 = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq('and the ref reports it', field(field(trunkRef1, 'object'), 'sha'), shaTw)
    const parked2 = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaTh }),
    })
    check(
      'attaching the second prepared commit advances',
      parked2.status === 200,
      String(parked2.status),
    )
    const trunkRef2 = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq('and the ref reports the advance', field(field(trunkRef2, 'object'), 'sha'), shaTh)
    const wholeChain = await get(`${at}/repos/${REPO}/commits`)
    check(
      'the branch lists the whole chain it was walked onto',
      Array.isArray(wholeChain) &&
        wholeChain.some((c) => String(field(c, 'sha')) === shaTh) &&
        wholeChain.some((c) => String(field(c, 'sha')) === shaTw),
      String(Array.isArray(wholeChain) ? wholeChain.length : -1),
    )

    // ---- a commit that does NOT build on the head is a divergence, not an
    // advance, so pointing the ref at it is forced even though it is the
    // newest thing in the repository. This is the difference stated parents
    // buy: order of creation is not ancestry.
    const ts = await stage(at, 'tasks/sibling.md', '# sibling\n')
    const sibling = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add a sibling',
      tree: ts,
      parents: [shaTw],
    })
    const shaSib = String(field(sibling.body, 'sha') ?? '')
    const diverge = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaSib }),
    })
    check('a divergent sibling is refused unforced', diverge.status === 422, String(diverge.status))
    const forcedSib = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaSib, force: true }),
    })
    check('and lands when forced', forcedSib.status === 200, String(forcedSib.status))

    // ---- a /contents write advanced its ref the moment it landed, so it is
    // attached history: a backward PATCH past it is forced, and forcing
    // discards it like any other commit the reset abandons.
    const tF = await stage(at, 'tasks/fourteen.md', '# fourteen\n')
    const fourteen = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task fourteen',
      tree: tF,
    })
    const shaF = String(field(fourteen.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-5', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF }),
    })
    const put = await fetch(`${at}/repos/${REPO}/contents/tasks/fifteen.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add fifteen via contents',
        content: Buffer.from('# fifteen\n').toString('base64'),
        branch: 'task-5',
      }),
    })
    check('a contents write lands on the branch', put.status === 201, String(put.status))
    const pastSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF }),
    })
    check(
      'a backward PATCH past a contents commit is refused without force',
      pastSoft.status === 422,
      String(pastSoft.status),
    )
    const pastForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF, force: true }),
    })
    check('and lands when forced', pastForced.status === 200, String(pastForced.status))
    const pastRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-5`)
    eq('the ref reports the reset commit', field(field(pastRef, 'object'), 'sha'), shaF)
    const pastList = await get(`${at}/repos/${REPO}/commits?sha=task-5`)
    check(
      'and the contents commit left the history',
      Array.isArray(pastList) &&
        !pastList.some(
          (c) => String(field(field(c, 'commit'), 'message')) === 'Add fifteen via contents',
        ),
      'Add fifteen via contents',
    )

    // ---- a /contents write after a forced reset cannot reproduce the sha of
    // the commit the reset abandoned: the address covers the bytes, so the
    // same message on the same parent with different content is a different
    // commit.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-6', sha: '' })
    const base6 = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/task-6`), 'object'), 'sha'),
    )
    const w1 = await fetch(`${at}/repos/${REPO}/contents/tasks/reused.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'One message',
        content: Buffer.from('first\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const firstSha = String(field(field(await w1.json(), 'commit'), 'sha'))
    if (base6 !== '') {
      await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ sha: base6, force: true }),
      })
    }
    const w2 = await fetch(`${at}/repos/${REPO}/contents/tasks/reused.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'One message',
        content: Buffer.from('second, different bytes\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const secondSha = String(field(field(await w2.json(), 'commit'), 'sha'))
    check(
      'a contents commit after a reset cannot reuse an abandoned sha',
      firstSha !== secondSha && secondSha !== '',
      `${firstSha} vs ${secondSha}`,
    )

    // ---- a commit prepared before the branch moved on is stale: the ref has
    // advanced through /contents since, so pointing back at it is a reset and
    // needs force, whatever order the two were created in.
    const tStale = await stage(at, 'tasks/stale.md', '# stale\n')
    const staleHead = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/task-6`), 'object'), 'sha'),
    )
    const stale = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Prepared before the write',
      tree: tStale,
      parents: [staleHead],
    })
    const shaStale = String(field(stale.body, 'sha') ?? '')
    await fetch(`${at}/repos/${REPO}/contents/tasks/after.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Written after the commit was prepared',
        content: Buffer.from('after\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const staleSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaStale }),
    })
    check(
      'a stale prepared commit is refused once a contents write moved the ref',
      staleSoft.status === 422,
      String(staleSoft.status),
    )
    const staleForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaStale, force: true }),
    })
    check('and lands when forced', staleForced.status === 200, String(staleForced.status))

    // ---- a branch can be created directly at a commit no ref names yet,
    // which is the two-step a client takes when it builds a branch from
    // scratch: commit, then point a new ref at it. The branch starts at that
    // commit and carries its tree, rather than inheriting some other ref's.
    const tN = await stage(at, 'tasks/newbranch.md', '# new branch\n')
    const newborn = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Commit for a branch that does not exist yet',
      tree: tN,
    })
    const shaN = String(field(newborn.body, 'sha') ?? '')
    const atCommit = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-7',
      sha: shaN,
    })
    check(
      'a ref can be created at a dangling commit',
      atCommit.status === 201,
      String(atCommit.status),
    )
    eq('and the new ref reports that commit', field(field(atCommit.body, 'object'), 'sha'), shaN)
    const bornRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-7`)
    eq('which survives a re-read', field(field(bornRef, 'object'), 'sha'), shaN)
    const bornList = await get(`${at}/repos/${REPO}/commits?sha=task-7`)
    check(
      'the branch history starts at that commit',
      Array.isArray(bornList) && String(field(bornList[0] ?? null, 'sha')) === shaN,
      String(field((Array.isArray(bornList) ? bornList[0] : null) ?? null, 'sha')),
    )
    const bornFile = await fetch(`${at}/repos/${REPO}/contents/tasks/newbranch.md?ref=task-7`, {
      headers: HEADERS,
    })
    check("and carries that commit's tree", bornFile.status === 200, String(bornFile.status))

    // ---- a seeded branch carries files and no stored commit, and the ref
    // endpoint answers for it with a synthesized root. That root is the ref's
    // position, so it is what a first update is judged against: a commit that
    // does not build on it would discard the seeded tree, which is a reset.
    const reseed = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('the fixture is seeded again', reseed.status === 200, String(reseed.status))
    const seededRoot = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`), 'object'), 'sha'),
    )
    check('a seeded branch answers with a root commit', seededRoot !== '', seededRoot)

    // A commit that states no parent at all is a root commit, which is what an
    // empty `parents` means: it is not the absent field, and it must not be
    // quietly re-parented onto the branch head.
    const tR = await stage(at, 'tasks/rootish.md', '# rootish\n')
    const rootish = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'A root commit',
      tree: tR,
      parents: [],
    })
    const shaRootish = String(field(rootish.body, 'sha') ?? '')
    const implied = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'A root commit',
      tree: tR,
    })
    check(
      'an empty parents list is not the same commit as an absent one',
      String(field(implied.body, 'sha')) !== shaRootish,
      `${shaRootish} vs ${String(field(implied.body, 'sha'))}`,
    )

    const overwrite = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaRootish }),
    })
    check(
      'a commit that does not build on the seeded root is refused',
      overwrite.status === 422,
      String(overwrite.status),
    )
    const keptRef = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq(
      'and the branch still answers with its root',
      field(field(keptRef, 'object'), 'sha'),
      seededRoot,
    )

    // The same update, from a commit that DOES build on that root, is an
    // ordinary advance: this is the flow every client takes on a fresh repo.
    const onRoot = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Built on the seeded root',
      tree: tR,
      parents: [seededRoot],
    })
    const shaOnRoot = String(field(onRoot.body, 'sha') ?? '')
    const advanced = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaOnRoot }),
    })
    check(
      'a commit built on the root advances unforced',
      advanced.status === 200,
      String(advanced.status),
    )
    const forcedOver = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaRootish, force: true }),
    })
    check(
      'and the refused one lands when forced',
      forcedOver.status === 200,
      String(forcedOver.status),
    )

    // ---- a commit created with `parents: []` IS a root, so a branch standing
    // on it stands on nothing further. The synthesized root is the floor for a
    // chain that never reaches one of its own, not a parent stapled under
    // every history.
    const rootedList = await get(`${at}/repos/${REPO}/commits?sha=${trunk}`)
    check(
      'a stored root commit is the end of its branch history',
      Array.isArray(rootedList) &&
        rootedList.length === 1 &&
        String(field(rootedList[0] ?? null, 'sha')) === shaRootish,
      String(Array.isArray(rootedList) ? rootedList.length : -1),
    )

    // ---- a commit written through /contents is an object like any other, so
    // a ref can be pointed at it. It reached the branch by advancing the ref,
    // which is the one thing that used to make it unnameable: it carried no
    // staged tree, and the ref endpoint read a missing tree as a missing
    // commit.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-8', sha: '' })
    const c1 = await fetch(`${at}/repos/${REPO}/contents/tasks/first.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add the first file',
        content: Buffer.from('# first\n').toString('base64'),
        branch: 'task-8',
      }),
    })
    const shaC1 = String(field(field((await c1.json()) as JsonValue, 'commit'), 'sha') ?? '')
    check('a contents write records a commit', shaC1 !== '', shaC1)
    const selfMove = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-8`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaC1 }),
    })
    check(
      'a ref can be moved onto a contents commit',
      selfMove.status === 200,
      String(selfMove.status),
    )

    // ---- and that commit is a SNAPSHOT: a branch created at it carries the
    // files it recorded, not whatever the branch it came from holds now.
    const c2 = await fetch(`${at}/repos/${REPO}/contents/tasks/second.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add the second file',
        content: Buffer.from('# second\n').toString('base64'),
        branch: 'task-8',
      }),
    })
    check('the branch advances past it', c2.status === 201, String(c2.status))
    const snap = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-8-snap',
      sha: shaC1,
    })
    check('a ref can be created at the older one', snap.status === 201, String(snap.status))
    eq('and reports it', field(field(snap.body, 'object'), 'sha'), shaC1)
    const kept = await fetch(`${at}/repos/${REPO}/contents/tasks/first.md?ref=task-8-snap`, {
      headers: HEADERS,
    })
    check(
      'the snapshot carries what that commit recorded',
      kept.status === 200,
      String(kept.status),
    )
    const later = await fetch(`${at}/repos/${REPO}/contents/tasks/second.md?ref=task-8-snap`, {
      headers: HEADERS,
    })
    check('and not what the branch gained afterwards', later.status === 404, String(later.status))

    // REST and GraphQL return comments oldest first.
    const opened = await post(`${at}/repos/${REPO}/issues`, {
      title: 'License info. needed',
      body: 'Could you provide license info.?',
    })
    check('an issue is opened', opened.status === 201, String(opened.status))
    const issueNo = String(field(opened.body, 'number') ?? '')
    const empty = await get(`${at}/repos/${REPO}/issues/${issueNo}/comments`)
    eq('a fresh issue lists no comments', empty, [])
    for (const body of ['first', 'second']) {
      const said = await post(`${at}/repos/${REPO}/issues/${issueNo}/comments`, { body })
      check(`a comment is posted (${body})`, said.status === 201, String(said.status))
    }
    const thread = await get(`${at}/repos/${REPO}/issues/${issueNo}/comments`)
    const bodies = Array.isArray(thread) ? thread.map((c) => field(c, 'body')) : []
    eq('and both come back oldest first', bodies, ['first', 'second'])
    check(
      'each carries the author a grader checks',
      Array.isArray(thread) && thread.every((c) => field(field(c, 'user'), 'login') !== null),
      JSON.stringify(thread).slice(0, 200),
    )
    const noSuch = await fetch(`${at}/repos/${REPO}/issues/4242/comments`, { headers: HEADERS })
    check('an issue that is not there is 404', noSuch.status === 404, String(noSuch.status))

    // ---- `user:` and `org:` NARROW, which is the only reason to ask with one.
    // A caller scoped to one account and handed every account's repositories
    // cannot tell from the answer that it was not scoped at all.
    const OTHER = 'integ-archive'
    const born = await post(`${at}/orgs/${OTHER}/repos`, { name: 'repo-archived' })
    check('a repo is created under a second owner', born.status === 201, String(born.status))

    const found = async (q: string): Promise<JsonValue[]> => {
      const body = await get(`${at}/search/repositories?q=${encodeURIComponent(q)}`)
      const items = field(body, 'items')
      return Array.isArray(items) ? items.map((r) => field(r, 'full_name')).sort() : []
    }

    eq('`user:` lists that account and no other', await found('user:integ'), [
      'integ/data-v1',
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])
    eq('`org:` scopes the same way', await found(`org:${OTHER}`), [`${OTHER}/repo-archived`])
    eq('an account holding nothing is empty, not everything', await found('user:nobody'), [])
    eq('two of them OR together', await found(`user:nobody org:${OTHER}`), [
      `${OTHER}/repo-archived`,
    ])
    // The scope ANDs with the terms: `repo` matches all four rows by name, and
    // the owner is what keeps the fourth out.
    eq('a term widens only within the scope', await found('user:integ repo'), [
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])
    // Unscoped, that same term reaches every owner -- the looseness the fake
    // keeps on purpose, so that a caller hunting a row is shown it.
    eq('and reaches every owner when nothing scopes it', await found('repo'), [
      `${OTHER}/repo-archived`,
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])

    // ---- code search answers a query that names no repository, over every
    // repository the tenant holds, because an authenticated caller of the live
    // API is answered over all of GitHub rather than refused. The scope rules
    // below were measured against api.github.com on 2026-09-24. This block sits
    // after `found('repo')`, which `Repo-Mixed` would otherwise join, and before
    // the reset that reseeds.
    const codeSearch = async (
      q: string | null,
      prefix = '',
    ): Promise<{ status: number; body: JsonValue; items: string[] }> => {
      const query = q === null ? '' : `?q=${encodeURIComponent(q)}`
      const r = await fetch(`${at}${prefix}/search/code${query}`, { headers: HEADERS })
      const body = (await r.json()) as JsonValue
      const rows = field(body, 'items')
      // Keyed by the item's own `repository`, so an item filed under the wrong
      // repository reads as a different hit.
      const items = Array.isArray(rows)
        ? rows.map(
            (i) =>
              `${String(field(field(i, 'repository'), 'full_name'))}/${String(field(i, 'path'))}`,
          )
        : []
      return { status: r.status, body, items }
    }
    const hits = async (q: string): Promise<JsonValue> => {
      const r = await codeSearch(q)
      return r.status === 200 ? r.items : `HTTP ${String(r.status)}`
    }
    const MARK = 'quokkaseed'

    eq(
      'an unscoped query is answered, not refused',
      await codeSearch(MARK).then((r) => [r.status, r.body]),
      [200, { total_count: 0, incomplete_results: false, items: [] }],
    )

    const mixed = await post(`${at}/orgs/${OTHER}/repos`, { name: 'Repo-Mixed' })
    check('a mixed-case repo is created', mixed.status === 201, String(mixed.status))
    const CASED_OWNER = 'Integ-Case'
    const cased = await post(`${at}/orgs/${CASED_OWNER}/repos`, { name: 'zz-repo' })
    check('a repo is created under a mixed-case owner', cased.status === 201, String(cased.status))
    const write = async (repo: string, path: string, text: string): Promise<JsonValue> => {
      const r = await fetch(`${at}/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({
          message: `add ${path}`,
          content: Buffer.from(text).toString('base64'),
        }),
      })
      check(`a file is written to ${repo}`, r.status === 201, String(r.status))
      return field(field((await r.json()) as JsonValue, 'content'), 'sha')
    }
    // Three owners, one of them mixed-case, a mixed-case name, and `alpha` in
    // only two files. The repositories created last sort first by full name,
    // and `Integ-Case/zz-repo` sorts first by full name but last by name, so
    // creation order, name order and full-name order all read differently.
    await write(`${CASED_OWNER}/zz-repo`, 'docs/cased.md', `${MARK}\n`)
    const mixedSha = await write(`${OTHER}/Repo-Mixed`, 'notes/mixed.md', `${MARK}\n`)
    await write(`${OTHER}/repo-archived`, 'notes/shared.md', `${MARK} alpha\n`)
    await write('integ/repo-cli', 'notes/shared.md', `${MARK} alpha\n`)
    await write('integ/repo-v1', 'docs/shared.md', `${MARK}\n`)
    const MIXED = `${OTHER}/Repo-Mixed/notes/mixed.md`
    const ARCHIVED = `${OTHER}/repo-archived/notes/shared.md`
    const CLI = 'integ/repo-cli/notes/shared.md'
    const V1 = 'integ/repo-v1/docs/shared.md'
    const CASED = `${CASED_OWNER}/zz-repo/docs/cased.md`
    const ALL = [CASED, MIXED, ARCHIVED, CLI, V1]

    const everything = await codeSearch(MARK)
    eq('unscoped, every repository is searched, in full-name order', everything.items, ALL)
    eq('and the count is every hit', field(everything.body, 'total_count'), 5)
    const hitRows = field(everything.body, 'items')
    const repoOf = (row: JsonValue | undefined): JsonValue => {
      const repo = field(row ?? null, 'repository')
      return { name: field(repo, 'name'), full_name: field(repo, 'full_name') }
    }
    eq(
      'each hit names its own repository (first)',
      repoOf(Array.isArray(hitRows) ? hitRows[0] : undefined),
      {
        name: 'zz-repo',
        full_name: `${CASED_OWNER}/zz-repo`,
      },
    )
    eq(
      'each hit names its own repository (last)',
      repoOf(Array.isArray(hitRows) ? hitRows.at(-1) : undefined),
      {
        name: 'repo-v1',
        full_name: 'integ/repo-v1',
      },
    )
    for (const prefix of ['', '/api/v3']) {
      const r = await codeSearch('"Mixture-of-Depths"', prefix)
      eq(
        `a query matching nothing is a 200 with nothing (${prefix || '/'})`,
        [r.status, r.body],
        [200, { total_count: 0, incomplete_results: false, items: [] }],
      )
    }

    // `user:` and `org:` narrow and OR together; an owner compares
    // case-insensitively on both sides, as `searchRepos` does.
    eq('`user:` narrows code search to that owner', await hits(`user:integ ${MARK}`), [CLI, V1])
    eq('`org:` narrows the same way', await hits(`org:${OTHER} ${MARK}`), [MIXED, ARCHIVED])
    eq('an owner value compares case-insensitively', await hits(`user:INTEG-Archive ${MARK}`), [
      MIXED,
      ARCHIVED,
    ])
    eq('and so does the owner it is compared with', await hits(`org:integ-case ${MARK}`), [CASED])
    eq('an owner holding nothing is empty, not everything', await hits(`user:nobody ${MARK}`), [])
    eq('two owners OR together', await hits(`user:nobody org:${OTHER} ${MARK}`), [MIXED, ARCHIVED])

    // Several `repo:` OR together; with an owner as well, the two groups AND.
    eq(
      'several `repo:` OR together',
      await hits(`repo:integ/repo-cli repo:${OTHER}/repo-archived ${MARK}`),
      [ARCHIVED, CLI],
    )
    const twice = await codeSearch(`repo:integ/repo-cli repo:integ/repo-cli ${MARK}`)
    eq(
      'a repo named twice is searched once',
      [twice.items, field(twice.body, 'total_count')],
      [[CLI], 1],
    )
    eq('`repo:` and `user:` intersect', await hits(`repo:integ/repo-cli user:integ ${MARK}`), [CLI])
    eq(
      '`repo:` and `org:` intersect',
      await hits(`repo:integ/repo-cli repo:${OTHER}/repo-archived org:integ ${MARK}`),
      [CLI],
    )
    // Live refuses a disjoint intersection with a query-parse 422; an empty
    // answer is the looser equivalent and carries no engine artefact.
    eq(
      'a disjoint intersection is empty',
      await hits(`repo:integ/repo-cli user:${OTHER} ${MARK}`),
      [],
    )
    eq(
      'a missing repo among several is skipped',
      await hits(`repo:integ/repo-cli repo:integ/no-such ${MARK}`),
      [CLI],
    )
    // Live answers this 200 with nothing; the 404 predates unscoped search and
    // is kept.
    eq(
      'a query naming only a missing repo is 404',
      await hits(`repo:integ/no-such ${MARK}`),
      'HTTP 404',
    )
    eq(
      'and an owner does not turn that 404 into an answer',
      await hits(`repo:integ/no-such user:integ ${MARK}`),
      'HTTP 404',
    )
    eq('a `repo:` value is taken verbatim', await hits(`repo:${OTHER}/Repo-Mixed ${MARK}`), [MIXED])

    // Qualifier names are exact and case-sensitive, as live reads them;
    // anything else is a term, split by the tokenizer.
    eq('a word holding `::` stays terms', await hits(`${MARK}::alpha`), [ARCHIVED, CLI])
    eq(
      'an uppercase qualifier name is a term',
      await hits(`repo:integ/repo-v1 REPO:integ/repo-cli ${MARK}`),
      [],
    )
    eq('a negated qualifier is a term', await hits(`-repo:integ/repo-cli ${MARK}`), [])
    // Content and metadata filters are dropped rather than matched as words,
    // which only ever widens; live narrows by them.
    for (const name of ['language', 'extension', 'filename', 'in', 'size', 'fork']) {
      eq(`\`${name}:\` is dropped`, await hits(`repo:integ/repo-cli ${name}:x ${MARK}`), [CLI])
    }
    eq('and dropping one does not scope', await hits(`language:x ${MARK}`), ALL)
    // Live refuses an empty qualifier value with a query-parse 422.
    eq('an empty `user:` is dropped', await hits(`user: ${MARK}`), ALL)
    eq('an empty `repo:` is dropped', await hits(`repo: ${MARK}`), ALL)
    // Live lists every file in scope; the fake matches files by terms only.
    eq('a query of only a scope is empty', await hits('user:integ'), [])
    eq('a query of only a dropped filter is empty', await hits('language:python'), [])

    eq('`path:` narrows each repository', await hits(`path:notes ${MARK}`), [MIXED, ARCHIVED, CLI])
    eq('a term compares case-insensitively', await hits(`repo:integ/repo-cli QuokkaSeed`), [CLI])
    eq(
      'a `path:` value is taken verbatim',
      await hits(`repo:integ/repo-cli path:Notes ${MARK}`),
      [],
    )
    const one = await codeSearch(`repo:${OTHER}/Repo-Mixed ${MARK}`)
    const blobs = field(one.body, 'items')
    eq(
      'a hit carries the blob it names',
      Array.isArray(blobs)
        ? blobs.map((row) => ({
            name: field(row, 'name'),
            path: field(row, 'path'),
            sha: field(row, 'sha'),
            score: field(row, 'score'),
            repository: repoOf(row),
          }))
        : blobs,
      [
        {
          name: 'mixed.md',
          path: 'notes/mixed.md',
          sha: mixedSha,
          score: 1,
          repository: { name: 'Repo-Mixed', full_name: `${OTHER}/Repo-Mixed` },
        },
      ],
    )
    for (const prefix of ['', '/api/v3']) {
      for (const q of ['', '  ', null]) {
        const r = await codeSearch(q, prefix)
        eq(
          `an empty query is refused (${JSON.stringify(q)}, ${prefix || '/'})`,
          [r.status, field(r.body, 'message')],
          [422, 'Validation Failed'],
        )
      }
    }

    const commentsReset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'comments' }),
    })
    check('comment metadata fixture is seeded', commentsReset.status === 200)
    const query = `query($cursor: String) {
      repository(owner: "integ", name: "repo-comments") {
        issueOrPullRequest(number: 1) { ... on Issue {
          comments(first: 1, after: $cursor) {
            nodes { body author { login } authorAssociation includesCreatedEdit
              isMinimized minimizedReason viewerDidAuthor reactionGroups { content users { totalCount } } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }
    }`
    const graph = async (cursor: JsonValue): Promise<JsonValue> => {
      const response = await post(`${at}/graphql`, { query, variables: { cursor } })
      eq('GraphQL response has no errors', field(response.body, 'errors'), null)
      return field(
        field(field(field(response.body, 'data'), 'repository'), 'issueOrPullRequest'),
        'comments',
      )
    }
    const firstPage = await graph(null)
    const nodes = field(firstPage, 'nodes') as JsonValue[]
    eq('first GraphQL page respects its limit', nodes.length, 1)
    eq('GraphQL preserves nullable author and comment metadata', nodes[0] ?? null, {
      body: 'comment 1',
      author: null,
      authorAssociation: 'CONTRIBUTOR',
      includesCreatedEdit: true,
      isMinimized: true,
      minimizedReason: 'OUTDATED',
      viewerDidAuthor: false,
      reactionGroups: [
        { content: 'THUMBS_UP', users: { totalCount: 2 } },
        { content: 'LAUGH', users: { totalCount: 0 } },
      ],
    })
    eq('first page has a continuation', field(field(firstPage, 'pageInfo'), 'hasNextPage'), true)
    const lastPage = await graph(field(field(firstPage, 'pageInfo'), 'endCursor'))
    eq(
      'cursor advances to the last comment',
      (field(lastPage, 'nodes') as JsonValue[]).map((row) => field(row, 'body')),
      ['comment 2'],
    )
    eq('last page terminates pagination', field(field(lastPage, 'pageInfo'), 'hasNextPage'), false)

    // ---- GraphQL repository lists honour orderBy and filters, and a fork's
    // parent is found by identity, so renaming the source keeps it
    const v1Seed = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('the v1 fixture is seeded again', v1Seed.status === 200)
    const repositoryNames = async (login: string, args: string): Promise<JsonValue[]> => {
      const r = await post(`${at}/graphql`, {
        query: `{ repositoryOwner(login: "${login}") { repositories(first: 10${args}) { nodes { name } } } }`,
      })
      eq(`repositories(${args}) has no errors`, field(r.body, 'errors'), null)
      const page = field(field(field(r.body, 'data'), 'repositoryOwner'), 'repositories')
      return (field(page, 'nodes') as JsonValue[]).map((node) => field(node, 'name'))
    }
    eq(
      'repositories order by name ascending',
      await repositoryNames('integ', ', orderBy: { field: NAME, direction: ASC }'),
      ['data-v1', 'repo-cli', 'repo-trunc', 'repo-v1'],
    )
    eq(
      'repositories order by name descending',
      await repositoryNames('integ', ', orderBy: { field: NAME, direction: DESC }'),
      ['repo-v1', 'repo-trunc', 'repo-cli', 'data-v1'],
    )
    eq(
      'repositories a push order ties are listed by name',
      await repositoryNames('integ', ', orderBy: { field: PUSHED_AT, direction: DESC }'),
      ['data-v1', 'repo-cli', 'repo-trunc', 'repo-v1'],
    )
    const forked = await post(`${at}/repos/integ/repo-v1/forks`, { name: 'v1-fork' })
    check('the fork is created', forked.status < 300, String(forked.status))
    const renamed = await fetch(`${at}/repos/integ/repo-v1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ name: 'repo-v1-moved' }),
    })
    check('the source is renamed', renamed.status === 200, String(renamed.status))
    const parent = await post(`${at}/graphql`, {
      query:
        '{ repository(owner: "integ-user", name: "v1-fork") { isFork parent { name owner { login } } } }',
    })
    eq('a fork names its parent under the name it carries now', field(parent.body, 'data'), {
      repository: { isFork: true, parent: { name: 'repo-v1-moved', owner: { login: 'integ' } } },
    })
    eq(
      'isFork narrows a repository list to forks',
      await repositoryNames('integ-user', ', isFork: true'),
      ['v1-fork'],
    )
    eq(
      'isFork: false leaves the forks out',
      await repositoryNames('integ-user', ', isFork: false'),
      [],
    )
    process.stdout.write(`github selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
