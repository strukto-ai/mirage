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

import { describe, expect, it, vi } from 'vitest'
import type * as AccessorModule from './accessor.ts'
import { bodyValue, readCliFile, repoNumber } from './accessor.ts'
import {
  GitHubApiError,
  type GitHubResponse,
  type GitHubTransport,
} from '../../../../core/github/client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { issueComments } from '../../../../core/github/issue.ts'
import { commentsFor, commentsText } from './issue.ts'
import { GH } from './index.ts'
import { PathSpec } from '../../../../types.ts'
import { PartialOutputError } from '../../../errors.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import { api } from './api.ts'
import { deleteCmd, editCmd, fork, listCmd, rename, summary, view } from './repo.ts'

const DEC = new TextDecoder()

interface Call {
  method: string
  path: string
  body?: unknown
  params?: Record<string, string>
}

const CALLS: Call[] = []
let REPLY: unknown = {}
let RESPONSES: (GitHubResponse | GitHubApiError)[] = []

class FakeTransport implements GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.request('GET', path, undefined, params)
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const call: Call = { method, path }
    if (body !== undefined) call.body = body
    if (params !== undefined) call.params = params
    CALLS.push(call)
    return Promise.resolve(REPLY)
  }

  requestWithResponse(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<GitHubResponse> {
    const call: Call & { headers?: Record<string, string> } = { method, path }
    if (body !== undefined) call.body = body
    if (params !== undefined) call.params = params
    if (headers !== undefined) call.headers = headers
    CALLS.push(call)
    const next = RESPONSES.shift() ?? { data: REPLY, status: 200, headers: {} }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }
}

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => new FakeTransport() }
})

function inv(
  texts: string[],
  flags: CLIInvocation['flags'] = {},
  config: unknown = { token: 't' },
  extra: Partial<Pick<CLIInvocation, 'stdin' | 'doors' | 'argv'>> = {},
): CLIInvocation {
  return {
    config,
    argv: extra.argv ?? [],
    paths: [],
    texts,
    flags,
    stdin: extra.stdin ?? null,
    env: {},
    ...(extra.doors === undefined ? {} : { doors: extra.doors }),
  }
}

function text(result: CommandFnResult): string {
  if (result === null) throw new Error('expected a result tuple')
  return DEC.decode(result[0] as Uint8Array)
}

function reset(reply: unknown = {}): void {
  CALLS.length = 0
  REPLY = reply
  RESPONSES = []
}

describe('gh tree', () => {
  it('registers itself under the grammar gh uses', () => {
    expect(cliSpecFor('gh')).toBe(GH)
    expect(GH.subcommands.map((c) => c.name)).toEqual([
      'auth',
      'help',
      'version',
      'api',
      'issue',
      'pr',
      'repo',
      'release',
      'run',
      'workflow',
      'search',
    ])
    const repo = GH.subcommands.find((c) => c.name === 'repo')
    expect(repo?.subcommands.map((c) => c.name)).toEqual([
      'list',
      'clone',
      'view',
      'create',
      'fork',
      'rename',
      'edit',
      'delete',
    ])
    expect(repo?.subcommands.filter((c) => c.write).map((c) => c.name)).toEqual([
      'create',
      'fork',
      'rename',
      'edit',
      'delete',
    ])
    const groups = Object.fromEntries(
      GH.subcommands.map((group) => [group.name, group.subcommands.map((leaf) => leaf.name)]),
    )
    expect(groups.issue).toEqual(['list', 'view', 'create', 'edit', 'close', 'reopen', 'comment'])
    expect(groups.pr).toEqual([
      'list',
      'view',
      'create',
      'edit',
      'merge',
      'close',
      'comment',
      'diff',
      'checks',
    ])
    expect(groups.release).toEqual(['list', 'view', 'create'])
    expect(groups.run).toEqual(['list', 'view', 'rerun'])
    expect(groups.workflow).toEqual(['list', 'view', 'run'])
  })
})

describe('gh repo', () => {
  it('views the repository the operand names', async () => {
    reset({ full_name: 'o/r' })
    await view(inv(['o/r']))
    expect(CALLS).toEqual([
      { method: 'GET', path: '/repos/o/r' },
      { method: 'GET', path: '/repos/o/r/readme' },
    ])
  })

  it('asks GraphQL for exactly the JSON fields named, and no README', async () => {
    reset({ data: { repository: { parent: null, name: 'r' } } })
    const out = text(await view(inv(['o/r'], { json: 'parent,name' })))
    expect(CALLS).toEqual([
      {
        method: 'POST',
        path: 'graphql',
        body: {
          query:
            'query RepositoryInfo($owner: String!, $name: String!) {\n' +
            '    repository(owner: $owner, name: $name) {parent{id,name,owner{id,login}},name}\n  }',
          variables: { owner: 'o', name: 'r' },
        },
      },
    ])
    expect(out).toBe('{"name":"r","parent":null}\n')
  })

  // Go's encoder, which gh's exporter uses, escapes the two Unicode line
  // separators; with HTML escaping off, `<`, `>` and `&` stay raw.
  it("prints JSON as gh does: compact, in Go's escaping", async () => {
    reset({ data: { repository: { description: 'a<b>&c\u{2028}d\u{2029}\b\u{e9}' } } })
    const out = text(await view(inv(['o/r'], { json: 'description' })))
    expect(out).toBe('{"description":"a<b>&c\\u2028d\\u2029\\b\u{e9}"}\n')
  })

  // gh decodes the answer into Go structs and prints those: a null string is
  // "", a struct keeps every field (a user's databaseId is 0), a repository
  // with no topics prints null, and projectsV2 prints its untagged `Nodes`.
  it('prints each field in the shape gh decodes it into', async () => {
    reset({
      data: {
        repository: {
          description: null,
          assignableUsers: { nodes: [{ id: 'U1', login: 'ada', name: null }] },
          repositoryTopics: { nodes: [] },
          projectsV2: { nodes: [] },
          latestRelease: null,
          watchers: { totalCount: 3 },
          owner: { id: 'O1', login: 'o' },
          parent: { id: 'R0', name: 'up', owner: { id: 'O0', login: 'u' } },
        },
      },
    })
    const fields =
      'watchers,parent,owner,latestRelease,projectsV2,repositoryTopics,assignableUsers,description'
    const out = text(await view(inv(['o/r'], { json: fields })))
    expect(JSON.parse(out)).toStrictEqual({
      assignableUsers: [{ id: 'U1', login: 'ada', name: '', databaseId: 0 }],
      description: '',
      latestRelease: null,
      owner: { id: 'O1', login: 'o' },
      parent: { id: 'R0', name: 'up', owner: { id: 'O0', login: 'u' } },
      projectsV2: { Nodes: [] },
      repositoryTopics: null,
      watchers: { totalCount: 3 },
    })
    expect(Object.keys(JSON.parse(out) as object)).toEqual([
      'assignableUsers',
      'description',
      'latestRelease',
      'owner',
      'parent',
      'projectsV2',
      'repositoryTopics',
      'watchers',
    ])
  })

  it('refuses an unknown field before asking, listing every field gh exports', async () => {
    reset()
    const refusal = view(inv(['o/r'], { json: 'isFork,bogus' }))
    await expect(refusal).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(
        /^Unknown JSON field: "bogus"\nAvailable fields:\n {2}archivedAt\n {2}assignableUsers\n/,
      ) as unknown,
    })
    expect(CALLS).toEqual([])
  })

  it('words a GraphQL error the way gh does', async () => {
    reset({
      data: { repository: null },
      errors: [
        { message: "Could not resolve to a Repository with the name 'o/r'.", path: ['repository'] },
      ],
    })
    await expect(view(inv(['o/r'], { json: 'name' }))).rejects.toThrow(
      "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)",
    )
  })

  it("lists an owner's repositories over GraphQL for JSON output", async () => {
    reset({
      data: {
        repositoryOwner: {
          repositories: {
            nodes: [{ name: 'a', isFork: true }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })
    const out = text(await listCmd(inv(['acme'], { json: 'name,isFork', limit: 5 })))
    expect(CALLS).toHaveLength(1)
    const body = CALLS[0]?.body as { query: string; variables: unknown }
    expect(body.query).toContain('repositoryOwner(login: $owner)')
    expect(body.query).toContain('nodes{name,isFork}')
    expect(body.variables).toEqual({ perPage: 5, owner: 'acme' })
    expect(JSON.parse(out)).toEqual([{ isFork: true, name: 'a' }])
  })

  it('falls back to the install repo when no operand is given', async () => {
    reset({ full_name: 'cfg/repo' })
    await view(inv([], {}, { token: 't', repo: 'cfg/repo' }))
    expect(CALLS[0]?.path).toBe('/repos/cfg/repo')
  })

  it('refuses a line with no repository anywhere', async () => {
    reset()
    await expect(view(inv([]))).rejects.toThrow(/no repository given/)
  })

  it('refuses a repository that is not OWNER/REPO', async () => {
    reset()
    await expect(view(inv(['justaname']))).rejects.toThrow(/OWNER\/REPO/)
  })

  // gh's format is [HOST/]OWNER/REPO, so the owner and repo are the *last*
  // two segments. Reading the first two made `github.com/acme/tools` a
  // request for `github.com/acme` -- a different repository, reported as
  // success rather than as an error.
  it('drops the optional host segment rather than shifting the repo', async () => {
    reset({ full_name: 'acme/tools' })
    await view(inv(['github.com/acme/tools']))
    expect(CALLS[0]?.path).toBe('/repos/acme/tools')
  })

  it('refuses a spec with more segments than a host and a repository', async () => {
    reset()
    await expect(view(inv(['a/b/c/d']))).rejects.toThrow(/OWNER\/REPO/)
  })

  it('names the fork at creation time when --fork-name is given', async () => {
    reset({ full_name: 'me/renamed' })
    const out = await fork(inv(['o/r'], { fork_name: 'renamed' }))
    expect(CALLS).toEqual([{ method: 'POST', path: '/repos/o/r/forks', body: { name: 'renamed' } }])
    expect(out === null ? '' : text(out)).toContain('me/renamed')
  })

  it('forks under the source name when it is not', async () => {
    reset({ full_name: 'me/r' })
    await fork(inv(['o/r']))
    expect(CALLS[0]?.body).toEqual({})
  })

  it('refuses a remote for the current repository', async () => {
    await expect(fork(inv([], { remote: 'true' }, { token: 't', repo: 'o/r' }))).rejects.toThrow(
      '--remote is not supported',
    )
  })

  // gh takes the new name as the operand and the repository to rename as
  // -R, which is the reverse of what the shape of the line suggests.
  it('edits the settings named in one PATCH and prints nothing', async () => {
    reset({ names: ['old', 'keep'], data: { repository: { viewerCanAdminister: true } } })
    const out = await editCmd(
      inv(['o/r'], {
        description: 'd',
        enable_wiki: 'false',
        template: true,
        enable_secret_scanning: 'false',
        add_topic: ['new,keep'],
        remove_topic: ['old'],
      }),
    )
    expect(out === null ? '' : text(out)).toBe('')
    expect(CALLS.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', 'graphql', expect.objectContaining({ variables: { owner: 'o', name: 'r' } })],
      [
        'PATCH',
        '/repos/o/r',
        {
          description: 'd',
          has_wiki: false,
          is_template: true,
          security_and_analysis: { secret_scanning: { status: 'disabled' } },
        },
      ],
      ['GET', '/repos/o/r/topics', undefined],
      ['PUT', '/repos/o/r/topics', { names: ['keep', 'new'] }],
    ])
  })

  it('refuses a security edit the viewer cannot administer', async () => {
    reset({ data: { repository: { viewerCanAdminister: false } } })
    await expect(editCmd(inv(['o/r'], { enable_secret_scanning: true }))).rejects.toThrow(
      'you do not have sufficient permissions to edit repository security and analysis features',
    )
    expect(CALLS.map((call) => call.method)).toEqual(['POST'])
  })

  it('leaves the topics alone when the edit changes none', async () => {
    reset({ names: ['keep'] })
    await editCmd(inv(['o/r'], { add_topic: ['keep'], remove_topic: ['gone'] }))
    expect(CALLS.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /repos/o/r/topics'])
  })

  it.each([
    [{}, 'specify properties to edit when not running interactively'],
    [
      { visibility: 'private' },
      'use of --visibility flag requires --accept-visibility-change-consequences flag',
    ],
  ])('refuses %o as gh does without a terminal', async (flags, message) => {
    reset()
    await expect(editCmd(inv(['o/r'], flags))).rejects.toThrow(message)
    expect(CALLS).toEqual([])
  })

  it('deletes a named repository, reading a bare name as the viewer', async () => {
    reset({ login: 'me' })
    const out = await deleteCmd(inv(['tools'], { yes: true }))
    expect(out === null ? '' : text(out)).toBe('')
    expect(CALLS.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /user',
      'DELETE /repos/me/tools',
    ])
  })

  it('warns that --confirm is --yes under its deprecated name', async () => {
    reset()
    const out = await deleteCmd(inv(['o/r'], { confirm: true }))
    expect(DEC.decode(out?.[1].stderr as Uint8Array)).toBe(
      'Flag --confirm has been deprecated, use `--yes` instead\n',
    )
  })

  it.each([
    [[], { yes: true }, 'cannot non-interactively delete current repository'],
    [['o/r'], {}, '--yes required when not running interactively'],
  ])('refuses to delete %o %o without a terminal', async (texts, flags, message) => {
    reset()
    await expect(deleteCmd(inv(texts, flags))).rejects.toThrow(message)
    expect(CALLS).toEqual([])
  })

  it('renames the -R repository to the operand', async () => {
    reset({ full_name: 'me/after' })
    await rename(inv(['after'], { repo: 'me/before' }))
    expect(CALLS).toEqual([{ method: 'PATCH', path: '/repos/me/before', body: { name: 'after' } }])
  })
})

describe('gh file input', () => {
  it('keeps a resolved path and materializes streamed file content', async () => {
    const path = new PathSpec({
      virtual: '/scratch/body.md',
      directory: '/scratch/',
      vfsPath: 'body.md',
      rawPath: './body.md',
    })
    const content = ['first ', 'second']
    const dispatch = vi.fn(async function* () {
      for (const chunk of content) yield await Promise.resolve(new TextEncoder().encode(chunk))
    })
    const read = vi.fn(() => Promise.resolve([dispatch(), new IOResult()] as [unknown, IOResult]))
    const call = inv([], {}, { token: 't' }, { doors: { dispatch: read } })
    expect(DEC.decode(await readCliFile(call, path, '--body-file'))).toBe('first second')
    expect(read).toHaveBeenCalledWith('read', path)
  })

  it('reads short -F - from standard input after path resolution', async () => {
    const flags = {
      body_file: new PathSpec({ virtual: '/-', directory: '/', vfsPath: '-', rawPath: '-' }),
    }
    for (const argv of [
      ['issue', 'create', '-F', '-'],
      ['issue', 'create', '-F-'],
    ]) {
      const value = await bodyValue(
        inv([], flags, { token: 't' }, { stdin: new TextEncoder().encode('short body'), argv }),
        new FlagView(flags),
      )
      expect(value).toBe('short body')
    }
  })
})

describe('gh issue and pull request subjects', () => {
  it('lets a full URL override the configured repository', () => {
    const flags = { repo: 'wrong/repo' }
    const [ref, number] = repoNumber(
      inv([], flags),
      new FlagView(flags),
      'https://github.com/acme/tools/issues/42',
      'issue',
      'issues',
    )
    expect({ ...ref, number }).toEqual({ owner: 'acme', repo: 'tools', number: 42 })
  })

  it('requires the URL kind to match the verb', () => {
    expect(() =>
      repoNumber(
        inv([]),
        new FlagView({}),
        'https://github.com/acme/tools/issues/42',
        'pull request',
        'pull',
      ),
    ).toThrow(/pull request number/)
  })
})

describe('gh api', () => {
  it('is a GET with no fields, and sends them as query parameters', async () => {
    reset({ ok: true })
    await api(inv(['repos/o/r/contents/x'], { raw_field: ['ref=master'], method: 'GET' }))
    expect(CALLS[0]).toEqual({
      method: 'GET',
      path: '/repos/o/r/contents/x',
      params: { ref: 'master' },
    })
  })

  it('is a POST once a field is given', async () => {
    reset({})
    await api(inv(['repos/o/r/issues'], { raw_field: ['title=hi'] }))
    expect(CALLS[0]?.method).toBe('POST')
  })

  it('sends -f verbatim and reads -F as JSON types', async () => {
    reset({})
    await api(
      inv(['x'], {
        method: 'PUT',
        raw_field: ['a=1'],
        field: ['b=2', 'c=true', 'd=null', 'e=text'],
      }),
    )
    expect(CALLS[0]?.body).toEqual({ a: '1', b: 2, c: true, d: null, e: 'text' })
  })

  it('keeps everything after the first = in the value', async () => {
    reset({})
    await api(inv(['x'], { raw_field: ['content=YQ==\n'] }))
    expect(CALLS[0]?.body).toEqual({ content: 'YQ==\n' })
  })

  it('takes an endpoint with or without a leading slash', async () => {
    reset({})
    await api(inv(['/user']))
    expect(CALLS[0]?.path).toBe('/user')
  })

  // gh sends `graphql` alone to the GraphQL endpoint (`p == "graphql"`) and
  // any other spelling, `/graphql` included, under the REST base.
  it('names GraphQL by the bare graphql endpoint alone', async () => {
    reset({})
    await api(inv(['graphql'], { raw_field: ['query={ viewer { login } }'] }))
    await api(inv(['/graphql']))
    expect(CALLS.map((call) => call.path)).toEqual(['graphql', '/graphql'])
  })

  it('refuses a field that is not key=value', async () => {
    reset({})
    await expect(api(inv(['x'], { raw_field: ['nope'] }))).rejects.toThrow(/key=value/)
  })

  // Real gh sends no body for a call carrying no fields, so a bare DELETE
  // is a bare DELETE rather than an empty JSON object with a content type.
  it('sends no body at all when no field was given', async () => {
    reset({})
    await api(inv(['repos/o/r'], { method: 'DELETE' }))
    expect(CALLS[0]).toEqual({ method: 'DELETE', path: '/repos/o/r' })
  })

  // -F types a value for a JSON body; on a GET the same value has to reach
  // the query string, where everything is a string.
  it('stringifies a typed field when the method puts it in the query', async () => {
    reset({})
    await api(inv(['search/code'], { method: 'GET', field: ['per_page=5', 'draft=true'] }))
    expect(CALLS[0]?.params).toEqual({ per_page: '5', draft: 'true' })
    expect(CALLS[0]?.body).toBeUndefined()
  })

  it('builds nested objects and arrays', async () => {
    reset({})
    await api(
      inv(['x'], {
        field: ['config[enabled]=true', 'labels[]=bug', 'labels[]=agent', 'empty[]'],
      }),
    )
    expect(CALLS[0]?.body).toEqual({
      config: { enabled: true },
      labels: ['bug', 'agent'],
      empty: [],
    })
  })

  it('reads typed @- values from stdin', async () => {
    reset({})
    await api(
      inv(
        ['x'],
        { field: ['body=@-'] },
        { token: 't' },
        { stdin: new TextEncoder().encode('from stdin') },
      ),
    )
    expect(CALLS[0]?.body).toEqual({ body: 'from stdin' })
  })

  it('uses --input as the body and moves fields to the query', async () => {
    reset({})
    await api(
      inv(
        ['x'],
        { method: 'PATCH', input: '-', raw_field: ['mode=strict'] },
        { token: 't' },
        { stdin: new TextEncoder().encode('{"enabled":true}'), argv: ['api', 'x', '--input', '-'] },
      ),
    )
    expect(CALLS[0]).toEqual({
      method: 'PATCH',
      path: '/x',
      body: { enabled: true },
      params: { mode: 'strict' },
    })
  })

  it('preserves an explicit JSON null from --input', async () => {
    reset({})
    await api(
      inv(
        ['x'],
        { input: '-' },
        { token: 't' },
        { stdin: new TextEncoder().encode('null'), argv: ['api', 'x', '--input', '-'] },
      ),
    )
    expect(CALLS[0]).toEqual({ method: 'POST', path: '/x', body: null })
  })

  it('passes custom headers without replacing defaults', async () => {
    reset({})
    await api(inv(['x'], { header: ['Accept: text/plain', 'X-Probe: yes'] }))
    expect((CALLS[0] as Call & { headers?: Record<string, string> }).headers).toEqual({
      Accept: 'text/plain',
      'X-Probe': 'yes',
    })
  })

  it('follows Link headers and slurps pages', async () => {
    reset()
    RESPONSES = [
      {
        data: [{ id: 1 }],
        status: 200,
        headers: { link: '<http://fake/items?page=2>; rel="next"' },
      },
      { data: [{ id: 2 }], status: 200, headers: {} },
    ]
    const out = await api(inv(['items'], { paginate: true, slurp: true }))
    expect(CALLS.map((call) => call.path)).toEqual(['/items', '/items?page=2'])
    expect(out === null ? '' : text(out)).toBe('[[{"id":1}],[{"id":2}]]')
  })

  // gh copies each body out verbatim, the vendor's compact text with no
  // newline added, and a paginated run streams array pages as one array
  // (its paginatedArrayReader); an empty page leaves a space behind.
  it.each([
    ['one body', [[{ id: 1 }]], false, '[{"id":1}]'],
    ['array pages', [[1, 2], [3]], true, '[1,2,3]'],
    ['an empty page between', [[1], [], [2]], true, '[1 ,2]'],
    ['object pages', [{ a: 1 }, { a: 2 }], true, '{"a":1}{"a":2}'],
  ] as const)('prints %s as gh does', async (_name, bodies, paginate, stdout) => {
    reset()
    RESPONSES = bodies.map((data, index) => ({
      data,
      status: 200,
      headers:
        index < bodies.length - 1
          ? { link: `<http://fake/items?page=${String(index + 2)}>; rel="next"` }
          : {},
    }))
    const out = await api(inv(['items'], paginate ? { paginate: true } : {}))
    expect(out === null ? '' : text(out)).toBe(stdout)
  })

  it('strips the Enterprise API prefix from Link pages', async () => {
    reset()
    RESPONSES = [
      {
        data: [{ id: 1 }],
        status: 200,
        headers: { link: '<https://git.example/api/v3/items?page=2>; rel="next"' },
      },
      { data: [{ id: 2 }], status: 200, headers: {} },
    ]
    await api(
      inv(['items'], { paginate: true }, { token: 't', baseUrl: 'https://git.example/api/v3' }),
    )
    expect(CALLS.map((call) => call.path)).toEqual(['/items', '/items?page=2'])
  })

  it('suppresses --silent output', async () => {
    reset({ ok: true })
    const out = await api(inv(['x'], { method: 'POST', silent: true }))
    expect(out === null ? '' : text(out)).toBe('')
  })

  it('copies a body that is not text out as its bytes', async () => {
    reset()
    RESPONSES = [{ data: new Uint8Array([0x50, 0x4b, 0xff, 0x00]), status: 200, headers: {} }]
    const out = await api(inv(['repos/o/r/actions/runs/1/logs']))
    expect(out?.[0]).toEqual(new Uint8Array([0x50, 0x4b, 0xff, 0x00]))
  })
})

// gh 2.85's `-i` (api.go processResponse): the protocol and status, every
// header but Status in name order ending `\r\n`, a blank `\r\n` line, then
// the body, for every response, the failing one included.
describe('gh api --include', () => {
  const HEADERS = {
    'x-github-request-id': 'AB:CD',
    'content-type': 'application/json; charset=utf-8',
    status: '200 OK',
  }
  const HEAD =
    'HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: AB:CD\r\n\r\n'

  it('prints the status line and headers before the body', async () => {
    reset()
    RESPONSES = [{ data: { a: 1 }, status: 200, headers: HEADERS }]
    const out = await api(inv(['x'], { include: true }))
    expect(out === null ? '' : text(out)).toBe(`${HEAD}{"a":1}`)
  })

  it('drops the headers of the encoded body it no longer prints', async () => {
    reset()
    RESPONSES = [
      {
        data: null,
        status: 204,
        headers: { 'content-encoding': 'gzip', 'content-length': '20', etag: 'W/"1"' },
      },
    ]
    const out = await api(inv(['x'], { include: true, method: 'DELETE' }))
    expect(out === null ? '' : text(out)).toBe('HTTP/1.1 204 No Content\nEtag: W/"1"\r\n\r\n')
  })

  it('heads every page, a newline between, and prints pages as they came', async () => {
    reset()
    RESPONSES = [
      { data: [1], status: 200, headers: { link: '<http://fake/x?page=2>; rel="next"' } },
      { data: [2], status: 200, headers: {} },
    ]
    const out = await api(inv(['x'], { include: true, paginate: true }))
    expect(out === null ? '' : text(out)).toBe(
      'HTTP/1.1 200 OK\nLink: <http://fake/x?page=2>; rel="next"\r\n\r\n[1]\nHTTP/1.1 200 OK\n\r\n[2]',
    )
  })

  it("opens each --slurp page before its head, as gh's writer does", async () => {
    reset()
    RESPONSES = [
      { data: [1], status: 200, headers: { link: '<http://fake/x?page=2>; rel="next"' } },
      { data: [2], status: 200, headers: {} },
    ]
    const out = await api(inv(['x'], { include: true, paginate: true, slurp: true }))
    expect(out === null ? '' : text(out)).toBe(
      '[HTTP/1.1 200 OK\nLink: <http://fake/x?page=2>; rel="next"\r\n\r\n[1]\n,HTTP/1.1 200 OK\n\r\n[2]]',
    )
  })

  it('keeps the heads under --silent and puts them before --jq output', async () => {
    reset()
    RESPONSES = [{ data: { a: 1 }, status: 200, headers: HEADERS }]
    const silent = await api(inv(['x'], { include: true, silent: true }))
    expect(silent === null ? '' : text(silent)).toBe(HEAD)
    RESPONSES = [{ data: { a: 1 }, status: 200, headers: HEADERS }]
    const filtered = await api(inv(['x'], { include: true, jq: '.a' }))
    expect(filtered === null ? '' : text(filtered)).toBe(`${HEAD}1\n`)
  })

  it('heads a failing response too', async () => {
    reset()
    RESPONSES = [
      new GitHubApiError('Not Found', 404, '{"message":"Not Found"}', 'u', {
        'content-type': 'application/json',
      }),
    ]
    const out = await api(inv(['x'], { include: true }))
    expect(out === null ? '' : text(out)).toBe(
      'HTTP/1.1 404 Not Found\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
    )
    expect(DEC.decode(out?.[1].stderr as Uint8Array)).toBe('gh: Not Found (HTTP 404)\n')
  })
})

// `--jq` renders the way gh 2.85 does, probed live: a string raw, null as
// an empty line, everything else as compact JSON with its keys sorted, one
// output per line.
describe('gh api --jq', () => {
  it('prints a string raw', async () => {
    reset({ full_name: 'o/r' })
    const out = await api(inv(['repos/o/r'], { jq: '.full_name' }))
    expect(out === null ? '' : text(out)).toBe('o/r\n')
  })

  it('prints non-strings as compact JSON', async () => {
    reset({ name: 'r', count: 2, ok: true })
    const out = await api(inv(['repos/o/r'], { jq: '{name: .name, count: .count}, .ok' }))
    expect(out === null ? '' : text(out)).toBe('{"count":2,"name":"r"}\ntrue\n')
  })

  // go-gh prints a number on its own line in fixed notation, whole with no
  // decimals and otherwise with two, rounded half to even as strconv rounds;
  // anything else goes through Go's json.Marshal: keys sorted, <, > and &
  // escaped for HTML and U+2028 and U+2029 for JavaScript, DEL raw, and
  // numbers spelled as ES6 spells them. Pinned against gh 2.85's go-gh with
  // `gh api rate_limit --jq`.
  it.each([
    ['1.5', '1.50'],
    ['0.125', '0.12'],
    ['0.375', '0.38'],
    ['-0.125', '-0.12'],
    ['2.675', '2.67'],
    ['1e-7', '0.00'],
    ['3.0', '3'],
    ['1e21', '1000000000000000000000'],
    ['.n / 3', '1666.67'],
    ['[.n / 3]', '[1666.6666666666667]'],
    ['[1.5, 1e21, 1e-7, 0.000001, 100]', '[1.5,1e+21,1e-7,0.000001,100]'],
    ['{"b": 1, "a": {"d": 2, "c": 3}}', '{"a":{"c":3,"d":2},"b":1}'],
    ['{"x": "<&>"}', '{"x":"\\u003c\\u0026\\u003e"}'],
    [
      '["\\u2028", "\\u2029", "\\u007f", "é", "\\u0001", "\\b"]',
      '["\\u2028","\\u2029","\x7f","é","\\u0001","\\b"]',
    ],
    ['[true, null, "x"]', '[true,null,"x"]'],
  ])('prints %s as go-gh does', async (program, line) => {
    reset({ n: 5000 })
    const out = await api(inv(['repos/o/r'], { jq: program }))
    expect(out === null ? '' : text(out)).toBe(`${line}\n`)
  })

  // gh prints a computed negative zero as -0, but jq.py hands it to Python as
  // the int 0, so both hosts print 0.
  it.each([
    ['.n * 0 * -1', '0'],
    ['[.n * 0 * -1]', '[0]'],
  ])('prints the negative zero of %s as 0', async (program, line) => {
    reset({ n: 5000 })
    const out = await api(inv(['repos/o/r'], { jq: program }))
    expect(out === null ? '' : text(out)).toBe(`${line}\n`)
  })

  it('prints null as an empty line', async () => {
    reset({ name: 'r' })
    const out = await api(inv(['repos/o/r'], { jq: '.nope' }))
    expect(out === null ? '' : text(out)).toBe('\n')
  })

  it('emits one line per output', async () => {
    reset({ a: 'x', b: 'y' })
    const out = await api(inv(['repos/o/r'], { jq: '.a, .b' }))
    expect(out === null ? '' : text(out)).toBe('x\ny\n')
  })

  // go-gh's gojq ends the output at `halt` and fails at halt_error, pinned
  // against gh: `halt error: <message>`, exit 1 whatever the code.
  it('ends the output at halt', async () => {
    reset({ a: 'x' })
    const out = await api(inv(['repos/o/r'], { jq: '.a, halt, .a' }))
    expect(out === null ? '' : text(out)).toBe('x\n')
  })

  it.each([
    ['"x" | halt_error(3)', 'halt error: x'],
    ['{"a":1} | halt_error', 'halt error: {"a":1}'],
    ['[.a] | map({v: .} | halt_error(0))', 'halt error: {"v":"x"}'],
  ])('fails at %s', async (program, message) => {
    reset({ a: 'x' })
    await expect(api(inv(['repos/o/r'], { jq: program }))).rejects.toThrow(message)
  })

  // gojq reports what the program raised with `error` as `error: <value>`,
  // anything but a string in gojq's own compact JSON (keys sorted), and a
  // builtin's error in words mirage's jq does not share, so jq 1.8.2's stand,
  // except for the builtins gojq writes in jq. Pinned against gh 2.85's gojq
  // with `gh api rate_limit --jq`.
  it.each([
    ['error("boom")', 'error: boom'],
    ['"x" | error', 'error: x'],
    ['error(null)', 'error: null'],
    ['error(error)', 'error: {"a":"x"}'],
    ['error({"b": 1, "a": [2, "x"]})', 'error: {"a":[2,"x"],"b":1}'],
    ['error(["\\u007f", "é", "<&>", "\\u0001"])', 'error: ["\\u007f","é","<&>","\\u0001"]'],
    ['error(1.0)', 'error: 1'],
    ['error(1e21)', 'error: 1e+21'],
    ['error(0.0000001)', 'error: 1e-7'],
    ['[error("in")]', 'error: in'],
    ['first(error("in"))', 'error: in'],
    ['try (.a | .b) catch error', 'error: Cannot index string with string ("b")'],
    ['.a | .b', 'Cannot index string with string ("b")'],
    ['label $f | .a | .b', 'Cannot index string with string ("b")'],
    ['def error: 7; error | .b', 'Cannot index number with string ("b")'],
    ['limit(-1; .a)', "error: limit doesn't support negative count"],
    ['skip(-1; .a)', "error: skip doesn't support negative count"],
    ['nth(-1; .a)', "error: nth doesn't support negative index"],
    ['{"b": 1, "a": 2} | halt_error(1)', 'halt error: {"a":2,"b":1}'],
  ])('fails %s the way gojq reports it', async (program, message) => {
    reset({ a: 'x' })
    const failure = await api(inv(['repos/o/r'], { jq: program })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PartialOutputError)
    const partial = failure as PartialOutputError
    expect([partial.message, new TextDecoder().decode(partial.stdout)]).toEqual([message, ''])
  })

  it.each([
    ['.a, ("y" | halt_error(1))', 'halt error: y'],
    ['.a, error("boom")', 'error: boom'],
    ['(try error(.a) catch .), error("y")', 'error: y'],
  ])('keeps what it printed before %s failed', async (program, message) => {
    reset({ a: 'x' })
    const failure = await api(inv(['repos/o/r'], { jq: program })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PartialOutputError)
    const partial = failure as PartialOutputError
    expect([partial.message, new TextDecoder().decode(partial.stdout)]).toEqual([message, 'x\n'])
  })
})

// gh prints two tab-separated header lines and then the README verbatim;
// with no README there is no `--` separator at all. Probed against 2.85.
describe('gh repo view rendering', () => {
  it('is two headers then the readme', () => {
    expect(summary({ full_name: 'o/r', description: 'd' }, '# Title\n')).toBe(
      'name:\to/r\ndescription:\td\n--\n# Title\n',
    )
  })

  it('omits the separator without a readme', () => {
    expect(summary({ full_name: 'o/r', description: null }, null)).toBe(
      'name:\to/r\ndescription:\t\n',
    )
  })
})

it('follows GraphQL comment cursors and propagates errors', async () => {
  const transport = new FakeTransport()
  const request = vi.spyOn(transport, 'request')
  const page = (body: string, more: boolean) => ({
    data: {
      repository: {
        issueOrPullRequest: {
          comments: { nodes: [{ body }], pageInfo: { hasNextPage: more, endCursor: 'next' } },
        },
      },
    },
  })
  request.mockResolvedValueOnce(page('first', true)).mockResolvedValueOnce(page('second', false))
  expect(await issueComments(transport, { owner: 'o', repo: 'r' }, 1)).toEqual([
    { body: 'first' },
    { body: 'second' },
  ])
  expect(request).toHaveBeenNthCalledWith(
    2,
    'POST',
    'graphql',
    expect.objectContaining({ variables: { owner: 'o', repo: 'r', number: 1, cursor: 'next' } }),
  )
  request.mockResolvedValueOnce({ errors: [{ message: 'Could not resolve repository' }] })
  await expect(issueComments(transport, { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
    'Could not resolve repository',
  )
})

it('formats deleted authors, edited/minimized comments and nonzero reactions like gh', async () => {
  const row = {
    author: null,
    authorAssociation: 'CONTRIBUTOR',
    includesCreatedEdit: true,
    isMinimized: true,
    minimizedReason: 'OUTDATED',
    body: 'comment',
    viewerDidAuthor: false,
    reactionGroups: [
      { content: 'THUMBS_UP', users: { totalCount: 2 } },
      { content: 'LAUGH', users: { totalCount: 0 } },
    ],
  }
  reset({
    data: {
      repository: {
        issueOrPullRequest: {
          comments: { nodes: [row], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  })
  const rows = await commentsFor(
    inv([], { comments: true }),
    new FlagView({ comments: true }),
    { owner: 'o', repo: 'r' },
    1,
  )
  expect(rows).toEqual([{ ...row, author: { login: '' }, reactionGroups: [row.reactionGroups[0]] }])
  expect(commentsText(rows ?? [])).toBe(
    'author:\t\nassociation:\tcontributor\nedited:\ttrue\nstatus:\toutdated\n--\ncomment\n--\n',
  )
})

it.each([
  [{}, ' {"message":"Not Found"}\n', ' {"message":"Not Found"}\n', 'gh: Not Found (HTTP 404)\n'],
  [{ silent: true }, '{"message":"Not Found"}', '', 'gh: Not Found (HTTP 404)\n'],
  [
    { jq: '.message' },
    '{"message":"Not Found"}',
    '{"message":"Not Found"}',
    'gh: Not Found (HTTP 404)\n',
  ],
  [{}, 'not found\n', 'not found\n', 'gh: HTTP 404\n'],
  [{}, '', '', 'gh: HTTP 404\n'],
] as const)('keeps HTTP error responses with flags %s', async (flags, body, stdout, stderr) => {
  const request = vi
    .spyOn(FakeTransport.prototype, 'requestWithResponse')
    .mockRejectedValue(new GitHubApiError('Not Found', 404, body))
  try {
    const result = await api(inv(['repos/o/missing'], flags))
    if (result === null) throw new Error('missing API result')
    expect(DEC.decode(await materialize(result[0]))).toBe(stdout)
    expect(DEC.decode(await materialize(result[1].stderr))).toBe(stderr)
    expect(result[1].exitCode).toBe(1)
  } finally {
    request.mockRestore()
  }
})

it.each([
  ['{"message":"Validation Failed","errors":"bad thing"}', 'gh: bad thing (Validation Failed)\n'],
  ['{"errors":"bad thing"}', 'gh: bad thing\n'],
  [
    '{"message":"Validation Failed","errors":[{"message":"one"}]}',
    'gh: Validation Failed (HTTP 422)\n',
  ],
  ['{"errors":[{"message":"one"},"two"]}', 'gh: one\ntwo\n'],
  ['{"errors":[{"code":"x"}]}', 'gh: HTTP 422\n'],
  ['{"errors":[]}', 'gh: HTTP 422\n'],
  ['{"message":""}', 'gh: HTTP 422\n'],
  ['["not", "an", "object"]', 'gh: HTTP 422\n'],
] as const)('names what gh reads off an error body: %s', async (body, stderr) => {
  const request = vi
    .spyOn(FakeTransport.prototype, 'requestWithResponse')
    .mockRejectedValue(new GitHubApiError('Validation Failed', 422, body))
  try {
    const result = await api(inv(['repos/o/r']))
    if (result === null) throw new Error('missing API result')
    expect(DEC.decode(await materialize(result[0]))).toBe(body)
    expect(DEC.decode(await materialize(result[1].stderr))).toBe(stderr)
    expect(result[1].exitCode).toBe(1)
  } finally {
    request.mockRestore()
  }
})

it.each([
  [
    { jq: '.value' },
    '{"message":"Validation Failed"}',
    'first\n{"message":"Validation Failed"}',
    'gh: Validation Failed (HTTP 422)\n',
  ],
  [
    { slurp: true },
    '{"message":"Validation Failed"}',
    '[{"value":"first"},{"message":"Validation Failed"}]',
    'gh: Validation Failed (HTTP 422)\n',
  ],
  [
    { slurp: true },
    'upstream unavailable\n',
    '[{"value":"first"},upstream unavailable\n]',
    'gh: HTTP 422\n',
  ],
  [{ slurp: true }, '', '[{"value":"first"},]', 'gh: HTTP 422\n'],
  [
    {},
    '{"message":"Validation Failed"}',
    '{"value":"first"}{"message":"Validation Failed"}',
    'gh: Validation Failed (HTTP 422)\n',
  ],
  [{ silent: true }, '{"message":"Validation Failed"}', '', 'gh: Validation Failed (HTTP 422)\n'],
] as const)(
  'keeps rendered pages when a later request fails: %s %j',
  async (flags, body, stdout, stderr) => {
    const request = vi
      .spyOn(FakeTransport.prototype, 'requestWithResponse')
      .mockResolvedValueOnce({
        data: { value: 'first' },
        status: 200,
        headers: { link: '</page2>; rel="next"' },
      })
      .mockRejectedValueOnce(new GitHubApiError('Validation Failed', 422, body))
    try {
      const result = await api(inv(['page1'], { paginate: true, ...flags }))
      if (result === null) throw new Error('missing API result')
      expect(DEC.decode(await materialize(result[0]))).toBe(stdout)
      expect(DEC.decode(await materialize(result[1].stderr))).toBe(stderr)
      expect(result[1].exitCode).toBe(1)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      request.mockRestore()
    }
  },
)

// gh runs `--jq` over each page as it lands, so a failure on a later page
// keeps the lines the earlier pages printed.
it.each([
  ['if .value == "second" then "y" | halt_error(1) else .value end', 'halt error: y'],
  ['if .value == "second" then error("boom") else .value end', 'error: boom'],
])('keeps the earlier pages when --jq %s fails on a later one', async (program, message) => {
  const request = vi
    .spyOn(FakeTransport.prototype, 'requestWithResponse')
    .mockResolvedValueOnce({
      data: { value: 'first' },
      status: 200,
      headers: { link: '</page2>; rel="next"' },
    })
    .mockResolvedValueOnce({ data: { value: 'second' }, status: 200, headers: {} })
  try {
    const failure = await api(inv(['page1'], { paginate: true, jq: program })).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(PartialOutputError)
    const partial = failure as PartialOutputError
    expect([partial.message, DEC.decode(partial.stdout)]).toEqual([message, 'first\n'])
  } finally {
    request.mockRestore()
  }
})

// A failing response after an array page is still a page to gh, so that
// array's closing bracket stays withheld and the failing body runs on.
it('leaves an array page open when a failing page follows it', async () => {
  const request = vi
    .spyOn(FakeTransport.prototype, 'requestWithResponse')
    .mockResolvedValueOnce({ data: [1], status: 200, headers: { link: '</page2>; rel="next"' } })
    .mockRejectedValueOnce(
      new GitHubApiError('Validation Failed', 422, '{"message":"Validation Failed"}'),
    )
  try {
    const result = await api(inv(['page1'], { paginate: true }))
    if (result === null) throw new Error('missing API result')
    expect(DEC.decode(await materialize(result[0]))).toBe('[1{"message":"Validation Failed"}')
    expect(result[1].exitCode).toBe(1)
  } finally {
    request.mockRestore()
  }
})

it.each([
  [{}, '{"errors":[{"message":"one"},{"message":"two"}],"data":null}'],
  [{ jq: '.data' }, '{"errors":[{"message":"one"},{"message":"two"}],"data":null}'],
  [{ silent: true }, ''],
] as const)('fails a graphql answer carrying errors as gh does: %j', async (flags, stdout) => {
  reset()
  RESPONSES = [
    {
      data: { errors: [{ message: 'one' }, { message: 'two' }], data: null },
      status: 200,
      headers: {},
    },
  ]
  const result = await api(
    inv(['graphql'], { raw_field: ['query={ viewer { login } }'], ...flags }),
  )
  if (result === null) throw new Error('missing API result')
  expect(DEC.decode(await materialize(result[0]))).toBe(stdout)
  expect(DEC.decode(await materialize(result[1].stderr))).toBe('gh: one\ntwo\n')
  expect(result[1].exitCode).toBe(1)
})

it('reads graphql errors only off the graphql endpoint', async () => {
  const data = { errors: [{ message: 'one' }] }
  reset()
  RESPONSES = [{ data, status: 200, headers: {} }]
  const result = await api(inv(['repos/o/r']))
  if (result === null) throw new Error('missing API result')
  expect(JSON.parse(DEC.decode(await materialize(result[0])))).toEqual(data)
  expect(result[1].exitCode).toBe(0)
})
