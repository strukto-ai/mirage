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
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'

// The battery cannot reach any of this: mirage has no Cloud Storage client, so
// no corpus case sends a request here. Every consumer of this fake lives
// outside the repo (a CLI, a python seeder and the BigQuery emulator's Go
// client), and the three of them disagree about which upload protocol to use,
// which is exactly the part a selftest has to hold.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-gcs'
const RUN = 'gcsrun'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`gcs selftest failed: ${name} ${detail}`)
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

const TENANTED = { 'x-mirage-tenant': TENANT }

function names(body: JsonValue): string[] {
  const items = (body as Record<string, JsonValue>).items
  return Array.isArray(items)
    ? items.map((r) => String((r as Record<string, JsonValue>).name ?? ''))
    : []
}

async function json(url: string, init: RequestInit = {}): Promise<JsonValue> {
  const r = await fetch(url, { ...init, headers: { ...TENANTED, ...(init.headers ?? {}) } })
  return (await r.json()) as JsonValue
}

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    const reset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1', epoch: '2026-03-01T00:00:00Z' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- buckets
    eq('the fixture buckets list', names(await json(`${at}/storage/v1/b?project=integ-project`)), [
      'integ-exports',
      'integ-reports',
    ])
    eq(
      'a prefix narrows the listing',
      names(await json(`${at}/storage/v1/b?project=integ-project&prefix=integ-e`)),
      ['integ-exports'],
    )
    const made = await fetch(`${at}/storage/v1/b?project=integ-project`, {
      method: 'POST',
      headers: { ...TENANTED, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'made-here' }),
    })
    check('a bucket is created', made.status === 200, String(made.status))
    const dup = await fetch(`${at}/storage/v1/b?project=integ-project`, {
      method: 'POST',
      headers: { ...TENANTED, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'made-here' }),
    })
    check('a duplicate bucket is 409', dup.status === 409, String(dup.status))

    // ---- uploadType=media, which is what the CLI's `gcs upload` sends
    const csv = 'a,b\nhello,1\nworld,2\n'
    const up = (await json(
      `${at}/upload/storage/v1/b/integ-exports/o?uploadType=media&name=one.csv`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: csv,
      },
    )) as Record<string, JsonValue>
    eq('a media upload reports its size', up.size ?? null, String(csv.length))
    // The checksums are the ones google-cloud-storage recomputes and compares;
    // a wrong crc32c aborts a resumable upload with DataCorruption and a wrong
    // md5 aborts a download. Both are pinned against the values fake-gcs-server
    // reported for these exact bytes.
    eq('crc32c is the Castagnoli one', up.crc32c ?? null, 'ByioSg==')
    eq('md5Hash is the content md5', up.md5Hash ?? null, 'zahnuLl2ikNJsgdUiKaAXA==')
    eq('the request Content-Type is stored', up.contentType ?? null, 'application/octet-stream')

    // ---- reads: metadata, alt=media, the /download prefix, and a range
    const meta = (await json(`${at}/storage/v1/b/integ-exports/o/one.csv`)) as Record<
      string,
      JsonValue
    >
    eq('metadata reads back by name', meta.name ?? null, 'one.csv')
    const media = await fetch(`${at}/storage/v1/b/integ-exports/o/one.csv?alt=media`, {
      headers: TENANTED,
    })
    eq('alt=media returns the bytes', await media.text(), csv)
    // The python client never uses the bare path: it follows `mediaLink`, which
    // is under /download. Both spellings have to reach the same object.
    const viaLink = await fetch(String(meta.mediaLink ?? ''), { headers: TENANTED })
    eq('the mediaLink resolves', await viaLink.text(), csv)
    const ranged = await fetch(`${at}/storage/v1/b/integ-exports/o/one.csv?alt=media`, {
      headers: { ...TENANTED, Range: 'bytes=0-3' },
    })
    check('a range is 206', ranged.status === 206, String(ranged.status))
    eq('a range serves the window', await ranged.text(), 'a,b\n')

    // ---- uploadType=multipart, byte for byte as the Go client sends it: an
    // UNQUOTED boundary, and a media part whose content ends in the newline the
    // delimiter's own CRLF must not eat.
    const boundary = '14dbf989e29b248a5962119a57dad4531e1de9ff4f8f6c112361ba20a522'
    const related = [
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      `${JSON.stringify({ bucket: 'integ-exports', name: 'multi.csv' })}\n\r\n`,
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`,
      `${csv}\r\n--${boundary}--\r\n`,
    ].join('')
    const multi = (await json(
      `${at}/upload/storage/v1/b/integ-exports/o?uploadType=multipart&name=multi.csv`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: related,
      },
    )) as Record<string, JsonValue>
    eq('a multipart upload keeps the trailing newline', multi.size ?? null, String(csv.length))
    eq('the media part Content-Type wins', multi.contentType ?? null, 'text/plain; charset=utf-8')
    eq('the multipart body is stored intact', multi.crc32c ?? null, 'ByioSg==')

    // ---- uploadType=resumable, which is the python client's chunked writer
    const open = await fetch(
      `${at}/upload/storage/v1/b/integ-exports/o?uploadType=resumable&name=big.bin`,
      {
        method: 'POST',
        headers: {
          ...TENANTED,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
        },
        body: JSON.stringify({ name: 'big.bin' }),
      },
    )
    check('a resumable init is 200', open.status === 200, String(open.status))
    const session = open.headers.get('location') ?? ''
    check('the init returns a Location', session !== '', session)
    const first = Buffer.alloc(8, 0x61)
    const rest = Buffer.alloc(5, 0x62)
    const partial = await fetch(session, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes 0-7/*` },
      body: first,
    })
    // 308, not 200. A 200 here makes the client stop and store 8 of 13 bytes,
    // which is the whole reason this status exists.
    check('a non-final chunk is 308', partial.status === 308, String(partial.status))
    eq('the 308 reports what arrived', partial.headers.get('range'), 'bytes=0-7')
    // A client that lost the 308 sends the same chunk again; its bytes must
    // land at their declared offset, not append a second copy.
    const repeat = await fetch(session, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes 0-7/*` },
      body: first,
    })
    check('a retransmitted chunk is still 308', repeat.status === 308, String(repeat.status))
    eq('and does not double the progress', repeat.headers.get('range'), 'bytes=0-7')
    // The recovery probe: an empty PUT with `bytes */*` asks where the upload
    // stands and must not finalize the partial bytes as an object.
    const probe = await fetch(session, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes */*` },
      body: Buffer.alloc(0),
    })
    check('a status probe answers 308', probe.status === 308, String(probe.status))
    eq('and reports the accepted range', probe.headers.get('range'), 'bytes=0-7')
    const done = (await json(session, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 8-12/13` },
      body: rest,
    })) as Record<string, JsonValue>
    eq('the final chunk stores the whole object', done.size ?? null, '13')
    const whole = await fetch(`${at}/storage/v1/b/integ-exports/o/big.bin?alt=media`, {
      headers: TENANTED,
    })
    eq('the chunks are concatenated in order', await whole.text(), 'aaaaaaaabbbbb')

    // ---- a client that knows the size sends the numeric total on EVERY
    // chunk: `bytes 0-7/13` is the first eight bytes of thirteen, not a
    // finished object, and reading the denominator as finality stored the
    // prefix and 404'd the rest of the upload.
    const open2 = await fetch(
      `${at}/upload/storage/v1/b/integ-exports/o?uploadType=resumable&name=sized.bin`,
      {
        method: 'POST',
        headers: {
          ...TENANTED,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
        },
        body: JSON.stringify({ name: 'sized.bin' }),
      },
    )
    const sized = open2.headers.get('location') ?? ''
    const early = await fetch(sized, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes 0-7/13` },
      body: first,
    })
    check('a sized intermediate chunk is 308', early.status === 308, String(early.status))
    eq('and reports what arrived', early.headers.get('range'), 'bytes=0-7')
    const finish = (await json(sized, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 8-12/13` },
      body: rest,
    })) as Record<string, JsonValue>
    eq('the chunk reaching total-1 finalizes', finish.size ?? null, '13')
    const sizedBody = await fetch(`${at}/storage/v1/b/integ-exports/o/sized.bin?alt=media`, {
      headers: TENANTED,
    })
    eq('the sized upload reads back whole', await sizedBody.text(), 'aaaaaaaabbbbb')
    // Removed again so the listing goldens below stay about their own writes.
    await fetch(`${at}/storage/v1/b/integ-exports/o/sized.bin`, {
      method: 'DELETE',
      headers: TENANTED,
    })

    // ---- a deleted bucket takes its pending resumable sessions with it: a
    // stale upload_id must not finalize an orphan object, and must not write
    // into a recreated bucket of the same name, which is another world's data.
    await fetch(`${at}/storage/v1/b?project=integ-project`, {
      method: 'POST',
      headers: { ...TENANTED, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'doomed' }),
    })
    const open3 = await fetch(
      `${at}/upload/storage/v1/b/doomed/o?uploadType=resumable&name=late.bin`,
      {
        method: 'POST',
        headers: {
          ...TENANTED,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
        },
        body: JSON.stringify({ name: 'late.bin' }),
      },
    )
    const stale = open3.headers.get('location') ?? ''
    const gone = await fetch(`${at}/storage/v1/b/doomed`, { method: 'DELETE', headers: TENANTED })
    check('an empty bucket with a pending upload deletes', gone.status === 204, String(gone.status))
    const orphan = await fetch(stale, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes 0-7/8` },
      body: first,
    })
    check('a chunk on a deleted bucket answers 404', orphan.status === 404, String(orphan.status))
    await fetch(`${at}/storage/v1/b?project=integ-project`, {
      method: 'POST',
      headers: { ...TENANTED, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'doomed' }),
    })
    const revived = await fetch(stale, {
      method: 'PUT',
      headers: { ...TENANTED, 'Content-Range': `bytes 0-7/8` },
      body: first,
    })
    check(
      'a recreated bucket does not revive the session',
      revived.status === 404,
      String(revived.status),
    )
    await fetch(`${at}/storage/v1/b/doomed`, { method: 'DELETE', headers: TENANTED })

    // ---- an overwrite keeps timeCreated, which is what the bq proxy's header
    // restore does to an object the emulator has just written.
    const again = (await json(
      `${at}/upload/storage/v1/b/integ-exports/o?uploadType=media&name=one.csv`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: `x,y\n${csv}`,
      },
    )) as Record<string, JsonValue>
    eq('an overwrite keeps timeCreated', again.timeCreated ?? null, meta.timeCreated ?? null)
    check(
      'an overwrite moves updated',
      String(again.updated ?? '') !== String(meta.updated ?? ''),
      `${String(meta.updated)} -> ${String(again.updated)}`,
    )

    // ---- listing, prefix, and the wildcard name the extract job writes
    await json(`${at}/upload/storage/v1/b/integ-exports/o?uploadType=media&name=out-*.csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: csv,
    })
    eq('objects list by name', names(await json(`${at}/storage/v1/b/integ-exports/o`)), [
      'big.bin',
      'multi.csv',
      'one.csv',
      'out-*.csv',
    ])
    // How the bq proxy resolves `gs://bucket/out-*.csv`: the emulator stores
    // the star VERBATIM, so the proxy lists on the prefix before the star.
    eq(
      'a prefix finds the star-named object',
      names(await json(`${at}/storage/v1/b/integ-exports/o?prefix=out-`)),
      ['out-*.csv'],
    )

    // ---- refusals
    const missBucket = await fetch(`${at}/storage/v1/b/nope`, { headers: TENANTED })
    check('a missing bucket is 404', missBucket.status === 404, String(missBucket.status))
    const missList = await fetch(`${at}/storage/v1/b/nope/o`, { headers: TENANTED })
    check('listing a missing bucket is 404', missList.status === 404, String(missList.status))
    const missMedia = await fetch(`${at}/storage/v1/b/integ-exports/o/nope?alt=media`, {
      headers: TENANTED,
    })
    check('a missing object read is 404', missMedia.status === 404, String(missMedia.status))
    // Plain text, not the JSON envelope: `alt=media` answers in the object's own
    // media type and fake-gcs-server answers the bare words.
    eq('a missing media read is plain text', await missMedia.text(), 'Not Found')
    const busy = await fetch(`${at}/storage/v1/b/integ-exports`, {
      method: 'DELETE',
      headers: TENANTED,
    })
    check('deleting a non-empty bucket is 412', busy.status === 412, String(busy.status))
    const empty = await fetch(`${at}/storage/v1/b/made-here`, {
      method: 'DELETE',
      headers: TENANTED,
    })
    check('deleting an empty bucket is 204', empty.status === 204, String(empty.status))

    // ---- deletes, which is how `bucket.delete(force=True)` empties one
    for (const name of ['big.bin', 'multi.csv', 'one.csv', 'out-*.csv']) {
      const gone = await fetch(
        `${at}/storage/v1/b/integ-exports/o/${encodeURIComponent(name)}?generation=1`,
        { method: 'DELETE', headers: TENANTED },
      )
      check(`${name} is deleted`, gone.status === 204, String(gone.status))
    }
    eq('the bucket is empty again', names(await json(`${at}/storage/v1/b/integ-exports/o`)), [])

    // ---- run isolation, which is the only thing a client can ask for here:
    // there is no credential, so `/_run/<id>` in the base URL is what separates
    // two hosts sharing one process.
    const scoped = `${at}/_run/${RUN}`
    const seeded = await fetch(`${scoped}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('a scoped /reset is 200', seeded.status === 200, String(seeded.status))
    const inRun = (await json(
      `${scoped}/upload/storage/v1/b/integ-exports/o?uploadType=media&name=only-here.csv`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: csv },
    )) as Record<string, JsonValue>
    // Every minted link carries the prefix, or a client following one leaves
    // its own run and reads an object that is not there.
    check(
      'a minted mediaLink carries the run prefix',
      String(inRun.mediaLink ?? '').includes(`/_run/${RUN}/download/`),
      String(inRun.mediaLink ?? ''),
    )
    eq(
      'the run holds its own object',
      names(await json(`${scoped}/storage/v1/b/integ-exports/o`)),
      ['only-here.csv'],
    )
    eq(
      'the default run does not see it',
      names(await json(`${at}/storage/v1/b/integ-exports/o`)),
      [],
    )

    process.stdout.write(`gcs selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
