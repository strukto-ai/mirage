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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { GENERAL_CURL, responseLines as renderResponseLines } from './curl.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface FetchCall {
  url: string
  init?: RequestInit
}

const RESPONSE_HEADERS: [string, string][] = [
  ['Content-Type', 'text/plain'],
  ['Content-Length', '10'],
]

function mockFetch(respBody: string, status = 200): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push({ url: urlStr, ...(init !== undefined ? { init } : {}) })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(ENC.encode(respBody).buffer),
      text: () => Promise.resolve(respBody),
      headers: new Headers(RESPONSE_HEADERS),
    } as unknown as Response)
  }) as typeof fetch
  return calls
}

// A 302 to /f and then the final response, as the redirecting server
// hands them to the client one hop at a time.
function mockRedirect(): FetchCall[] {
  const calls: FetchCall[] = []
  const hops = [
    { status: 302, statusText: 'Found', body: '302: Found', headers: [['Location', '/f']] },
    { status: 200, statusText: 'OK', body: 'hello body', headers: RESPONSE_HEADERS },
  ] as const
  globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push({ url: urlStr, ...(init !== undefined ? { init } : {}) })
    const hop = calls.length > 1 ? hops[1] : hops[0]
    return Promise.resolve({
      ok: hop.status === 200,
      status: hop.status,
      statusText: hop.statusText,
      arrayBuffer: () => Promise.resolve(ENC.encode(hop.body).buffer),
      text: () => Promise.resolve(hop.body),
      headers: new Headers(hop.headers as [string, string][]),
    } as unknown as Response)
  }) as typeof fetch
  return calls
}

// A server that never answers: the fetch settles only when the caller's
// signal aborts it, the way a real stalled connection would.
function mockStall(): void {
  globalThis.fetch = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
  ) as typeof fetch
}

async function runCurl(
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{
  out: string
  err: string
  exitCode: number
  writes: Record<string, Uint8Array | AsyncIterable<Uint8Array>>
}> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_CURL[0]
  if (cmd === undefined) throw new Error('curl not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', err: '', exitCode: -1, writes: {} }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return {
    out: DEC.decode(buf),
    err: await ioResult.stderrStr(),
    exitCode: ioResult.exitCode,
    writes: ioResult.writes,
  }
}

describe('curl', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch('hello body')
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('GET returns body', async () => {
    const r = await runCurl(['https://x.test/hi'])
    expect(r.out).toBe('hello body')
    expect(r.exitCode).toBe(0)
  })

  // Real curl prints nothing on stdout with -o: the body goes to the file and
  // the only stdout-adjacent output is the progress meter, which is on stderr.
  it('-o writes to file and prints nothing on stdout', async () => {
    const r = await runCurl(['https://x.test/file'], { output: '/tmp/out.txt' })
    const written = r.writes['/tmp/out.txt']
    expect(written).toBeInstanceOf(Uint8Array)
    if (written instanceof Uint8Array) {
      expect(DEC.decode(written)).toBe('hello body')
    }
    expect(r.out).toBe('')
  })

  it('-s with -o silences stdout', async () => {
    const r = await runCurl(['https://x.test/x'], { output: '/tmp/o', silent: true })
    expect(r.out).toBe('')
  })

  it('-X POST -d sends body', async () => {
    const calls = mockFetch('ok')
    const r = await runCurl(['https://x.test/p'], { request: 'POST', data: 'payload' })
    expect(r.exitCode).toBe(0)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new TextDecoder().decode(calls[0]?.init?.body as ArrayBuffer)).toBe('payload')
  })

  it('-H adds headers', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { header: 'X-Auth: token' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['X-Auth']).toBe('token')
  })

  it('sends default Mozilla User-Agent when none provided', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'])
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
  })

  it('-A overrides default User-Agent', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { user_agent: 'my-agent/9' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('my-agent/9')
  })

  it('-H User-Agent overrides default', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { header: 'User-Agent: from-H/1' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('from-H/1')
  })

  it('missing URL is a usage error with exit 2', async () => {
    await expect(runCurl([])).rejects.toMatchObject({ exitCode: 2 })
  })

  // Pinned against curl 8.14.1: an HTTP error status is a successful transfer.
  // The body is printed and the exit code stays 0 unless -f is given.
  it('prints the body and exits 0 on a 404 without -f', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('not found')
  })

  it('writes the error body to -o and exits 0 on a 404 without -f', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { output: '/tmp/e.txt' })
    expect(r.exitCode).toBe(0)
    const written = r.writes['/tmp/e.txt']
    if (written instanceof Uint8Array) expect(DEC.decode(written)).toBe('not found')
  })

  it('-f turns a 404 into exit 22 and writes nothing', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { fail: true, output: '/tmp/e.txt' })
    expect(r.exitCode).toBe(22)
    expect(r.err).toContain('curl: (22) The requested URL returned error: 404')
    expect(Object.keys(r.writes)).toHaveLength(0)
  })

  it('-sf keeps exit 22 but silences the message', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { fail: true, silent: true })
    expect(r.exitCode).toBe(22)
    expect(r.err).toBe('')
  })

  it('-sSf restores the message', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], {
      fail: true,
      silent: true,
      show_error: true,
    })
    expect(r.exitCode).toBe(22)
    expect(r.err).toContain('curl: (22)')
  })

  it('reports a refused connection as exit 7', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    const r = await runCurl(['http://127.0.0.1:1/x'])
    expect(r.exitCode).toBe(7)
    expect(r.err).toContain('curl: (7) Failed to connect to 127.0.0.1 port 1')
  })

  it('only follows redirects when -L is given', async () => {
    const calls = mockRedirect()
    const r = await runCurl(['http://x.test/r'])
    expect(calls.map((c) => c.url)).toEqual(['http://x.test/r'])
    expect(r.out).toBe('302: Found')
    const withL = mockRedirect()
    const followed = await runCurl(['http://x.test/r'], { location: true })
    expect(withL.map((c) => c.url)).toEqual(['http://x.test/r', 'http://x.test/f'])
    expect(followed.out).toBe('hello body')
  })
})

// Pinned against curl 8.7.1 / 8.14.1 (byte shapes captured with `cat -ve`
// against a local python http.server). Header names render lowercase in
// both hosts because fetch never exposes the wire casing, and the status
// line always says HTTP/1.1 because fetch cannot observe the version.
const RESPONSE_DUMP = 'HTTP/1.1 200 OK\r\ncontent-length: 10\r\ncontent-type: text/plain\r\n\r\n'
const HOP_DUMP = 'HTTP/1.1 302 Found\r\nlocation: /f\r\n\r\n'

describe('curl option surface (#1065)', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('long spellings reach the request', async () => {
    const calls = mockFetch('ok')
    await runCurl(['http://x.test/echo'], {
      request: 'PUT',
      header: 'X-Mirage-Test: yes',
      user_agent: 'agent/1',
    })
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.headers).toEqual({ 'X-Mirage-Test': 'yes', 'User-Agent': 'agent/1' })
  })

  it('--max-time turns a stalled transfer into exit 28', async () => {
    mockStall()
    const r = await runCurl(['http://x.test/f'], { max_time: 0.05 })
    expect(r.exitCode).toBe(28)
    expect(r.out).toBe('')
    expect(r.err).toMatch(
      /^curl: \(28\) Operation timed out after \d+ milliseconds with 0 bytes received\n$/,
    )
  })

  it('-s silences the timeout message but keeps exit 28', async () => {
    mockStall()
    const r = await runCurl(['http://x.test/f'], { max_time: 0.05, silent: true })
    expect(r.exitCode).toBe(28)
    expect(r.err).toBe('')
  })

  // curl 8.7.1: `option -m: expected a positive numerical parameter`, exit
  // 2, and -s does not mute an option error.
  it('a negative --max-time is refused before any transfer', async () => {
    const calls = mockFetch('ok')
    await expect(
      runCurl(['http://x.test/f'], { max_time: -1, silent: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(
        /^curl: option --max-time: expected a positive numerical parameter\n/,
      ) as string,
    })
    expect(calls).toHaveLength(0)
  })

  // curl 8.7.1 warns about two methods for one request and exits 2 before
  // any transfer; -s mutes the warning and -S does not bring it back, while
  // the option error -F adds is never muted.
  it("-I with -d is refused with curl's warning", async () => {
    const calls = mockFetch('ok')
    const r = await runCurl(['http://x.test/f'], { head: true, data: 'x' })
    expect(calls).toHaveLength(0)
    expect(r.out).toBe('')
    expect(r.exitCode).toBe(2)
    expect(r.err).toBe(
      'Warning: You can only select one HTTP request method! You asked for both POST \n' +
        'Warning: (-d, --data) and HEAD (-I, --head).\n',
    )
  })

  it('-s mutes the -I with -d warning but keeps exit 2', async () => {
    mockFetch('ok')
    const r = await runCurl(['http://x.test/f'], {
      head: true,
      data: 'x',
      silent: true,
      show_error: true,
    })
    expect(r.exitCode).toBe(2)
    expect(r.err).toBe('')
  })

  it('-I with -F adds an option error that -s never mutes', async () => {
    mockFetch('ok')
    const r = await runCurl(['http://x.test/f'], { head: true, form: 'a=b', silent: true })
    expect(r.exitCode).toBe(2)
    expect(r.err).toBe(
      "curl: option -F: is badly used here\ncurl: try 'curl --help' or 'curl --manual' for more information\n",
    )
  })

  // curl reads zero as "no limit" (curl 8.7.1: `-m 0` completes a transfer
  // that `-m .1` fails with 28), so no deadline reaches the client.
  it('--max-time 0 disables the deadline', async () => {
    vi.useFakeTimers()
    try {
      globalThis.fetch = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
            setTimeout(() => {
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                arrayBuffer: () => Promise.resolve(ENC.encode('late').buffer),
                headers: new Headers(RESPONSE_HEADERS),
              } as unknown as Response)
            }, 60_000)
          }),
      ) as typeof fetch
      const pending = runCurl(['http://x.test/f'], { max_time: 0 })
      await vi.advanceTimersByTimeAsync(60_000)
      const r = await pending
      expect(r.exitCode).toBe(0)
      expect(r.out).toBe('late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('-v dumps the request and response headers on stderr', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f?q=1'], { verbose: true })
    expect(r.out).toBe('hello body')
    expect(r.exitCode).toBe(0)
    const responseLines = RESPONSE_DUMP.split('\r\n').slice(0, -1)
    expect(r.err).toBe(
      '> GET /f?q=1 HTTP/1.1\r\n' +
        '> Host: x.test\r\n' +
        '> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n' +
        '> Accept: */*\r\n' +
        '> \r\n' +
        responseLines.map((line) => `< ${line}\r\n`).join(''),
    )
  })

  it('-v shows custom headers and the body headers', async () => {
    mockFetch('ok')
    const r = await runCurl(['http://x.test:8080/f'], {
      verbose: true,
      silent: true,
      request: 'POST',
      header: 'X-Test: 1',
      user_agent: 'agent/1',
      data: 'a=1',
    })
    expect(r.err.split('< ')[0]).toBe(
      '> POST /f HTTP/1.1\r\n' +
        '> Host: x.test:8080\r\n' +
        '> User-Agent: agent/1\r\n' +
        '> Accept: */*\r\n' +
        '> X-Test: 1\r\n' +
        '> Content-Length: 3\r\n' +
        '> Content-Type: application/x-www-form-urlencoded\r\n' +
        '> \r\n',
    )
  })

  it('-I prints the headers and sends HEAD', async () => {
    const calls = mockFetch('')
    const r = await runCurl(['http://x.test/f'], { head: true })
    expect(calls[0]?.init?.method).toBe('HEAD')
    expect(r.out).toBe(RESPONSE_DUMP)
    expect(r.exitCode).toBe(0)
  })

  // curl -I with an explicit -X GET still prints the headers alone (curl
  // 8.7.1): the body a GET carries is discarded, not appended.
  it('-I with -X GET sends GET and drops the body', async () => {
    const calls = mockFetch('hello body')
    const r = await runCurl(['http://x.test/f'], { head: true, request: 'GET' })
    expect(calls[0]?.init?.method).toBe('GET')
    expect(r.out).toBe(RESPONSE_DUMP)
  })

  // -d adds curl's own Content-Type to the request, and -v shows the one
  // that is sent: a -H Content-Type takes its place in the custom slot and
  // no default follows (curl 8.7.1).
  it('-d sends the form content type unless -H names one', async () => {
    const calls = mockFetch('ok')
    await runCurl(['http://x.test/f'], { data: 'a=1' })
    expect(calls[0]?.init?.headers).toEqual({
      'User-Agent': 'Mozilla/5.0 (compatible; mirage/1.0)',
      'Content-Type': 'application/x-www-form-urlencoded',
    })
    const custom = mockFetch('ok')
    const r = await runCurl(['http://x.test/f'], {
      data: '{}',
      header: 'Content-Type: application/json',
      verbose: true,
      silent: true,
    })
    expect(custom[0]?.init?.headers).toEqual({
      'User-Agent': 'Mozilla/5.0 (compatible; mirage/1.0)',
      'Content-Type': 'application/json',
    })
    expect(r.err.split('< ')[0]).toBe(
      '> POST /f HTTP/1.1\r\n' +
        '> Host: x.test\r\n' +
        '> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n' +
        '> Accept: */*\r\n' +
        '> Content-Type: application/json\r\n' +
        '> Content-Length: 2\r\n' +
        '> \r\n',
    )
  })

  it('-i prints the headers before the body', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f'], { include: true })
    expect(r.out).toBe(`${RESPONSE_DUMP}hello body`)
  })

  it("-i with -L prints every hop's headers before the final body", async () => {
    // curl 8.7.1 `-iL`: each hop's header block, then the final body alone;
    // the redirect's own body is never written.
    mockRedirect()
    const r = await runCurl(['http://x.test/r'], { location: true, include: true })
    expect(r.out).toBe(HOP_DUMP + RESPONSE_DUMP + 'hello body')
  })

  it("-I with -L prints every hop's headers and no body", async () => {
    mockRedirect()
    const r = await runCurl(['http://x.test/r'], { location: true, head: true })
    expect(r.out).toBe(HOP_DUMP + RESPONSE_DUMP)
  })

  it('-v with -L traces each request', async () => {
    mockRedirect()
    const r = await runCurl(['http://x.test/r'], { location: true, verbose: true })
    const lines = r.err
      .split('\r\n')
      .filter((l) => l.startsWith('> GET') || l.startsWith('< HTTP/'))
    expect(lines).toEqual([
      '> GET /r HTTP/1.1',
      '< HTTP/1.1 302 Found',
      '> GET /f HTTP/1.1',
      '< HTTP/1.1 200 OK',
    ])
  })

  it('-v with -L drops the body headers after a method switch', async () => {
    // The body rode the POST; the GET a 302 turns it into carries none, so
    // its request block shows no Content-Length or Content-Type.
    const calls = mockRedirect()
    const r = await runCurl(['http://x.test/r'], { location: true, verbose: true, data: 'a=1' })
    expect(calls.map((c) => c.init?.method)).toEqual(['POST', 'GET'])
    const [first, second] = r.err.split('< HTTP/1.1')
    expect(first).toContain('> POST /r HTTP/1.1')
    expect(first).toContain('> Content-Length: 3')
    expect(second).toContain('> GET /f HTTP/1.1')
    expect(second?.split('> \r\n')[0]).not.toContain('Content-')
  })

  it('-i with -o writes headers and body to the file', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f'], { include: true, output: '/tmp/out.txt' })
    expect(r.out).toBe('')
    expect(DEC.decode(r.writes['/tmp/out.txt'] as Uint8Array)).toBe(`${RESPONSE_DUMP}hello body`)
  })
})

describe('responseLines header order', () => {
  // The headers print sorted by name. GNU `sort` orders by byte, which is
  // code-point order: 'z', then U+FFFD, then U+1D11E. A `<`/`>` comparator
  // compares UTF-16 code units instead and puts the astral name second,
  // since its first unit D834 is below FFFD.
  it('sorts header names by code point, not by UTF-16 code unit', () => {
    const lines = renderResponseLines({
      status: 200,
      reason: 'OK',
      body: new Uint8Array(),
      url: 'https://example.test/',
      method: 'GET',
      headers: [
        ['x-z', '1'],
        ['x-\u{1D11E}', '2'],
        ['x-\uFFFD', '3'],
      ],
      history: [],
    })
    expect(lines[0]).toBe('HTTP/1.1 200 OK')
    expect(lines.slice(1)).toEqual(['x-z: 1', 'x-\uFFFD: 3', 'x-\u{1D11E}: 2'])
  })
})
