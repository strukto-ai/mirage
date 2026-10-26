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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../../../core/chroma/client.ts'

vi.mock('../../../../core/chroma/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../../../core/chroma/client.ts')
  return { ...actual, fetchPathTree: vi.fn() }
})

import type { Accessor } from '../../../../accessor/base.ts'
import * as clientMod from '../../../../core/chroma/client.ts'
import { IOResult } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { ChromaVFS } from '../../../../vfs/chroma/chroma.ts'
import { DifyVFS } from '../../../../vfs/dify/dify.ts'
import type { Files } from '../../../../workspace/files.ts'
import { Mount } from '../../../../workspace/mount/spec.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { parseCommand } from '../../../spec/parser.ts'
import { SEARCH, search } from './index.ts'

const PATH = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })

afterEach(() => {
  vi.unstubAllGlobals()
})

// Twin of test_the_spec_parses_query_paths_and_options.
it('parses the query, paths and options', () => {
  const parsed = parseCommand(
    SEARCH.spec,
    ['--method', 'hybrid', '--top-k', '5', '--threshold', '0.4', 'login docs', 'guides/*.md'],
    '/knowledge',
  )
  expect(parsed.flags).toMatchObject({ '--method': 'hybrid', '--top-k': '5', '--threshold': '0.4' })
  expect(parsed.args).toEqual([
    ['login docs', 'str'],
    ['/knowledge/guides/*.md', 'path'],
  ])
})

function context(dispatch: DispatchFn, flags: Record<string, string> = {}) {
  return {
    stdin: null,
    flags,
    spec: SEARCH.spec,
    cwd: PathSpec.fromStrPath('/'),
    vfs: { dispatch } as unknown as Files,
  }
}

describe('search', () => {
  // Twin of test_a_query_is_one_search_over_every_scope: only the options
  // the line names reach the mount, which defaults the rest.
  it('is one search over every scope', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve([
        [
          ['/data/a', 'highest'],
          ['/data/b', 'second'],
        ],
        new IOResult(),
      ]),
    )
    const result = await search(
      {} as Accessor,
      [PATH, PATH],
      ['question'],
      context(dispatch, { top_k: '2' }),
    )
    const [out] = result ?? [null]
    expect(new TextDecoder().decode(out as Uint8Array)).toBe('highest\nsecond\n')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(
      'search',
      PATH,
      [{ query: 'question', options: { top_k: 2 } }],
      {
        scopes: [PATH],
      },
    )
  })

  // Twin of test_a_declined_search_does_not_become_no_matches.
  it('fails a declined search instead of finding nothing', async () => {
    const dispatch = vi.fn<DispatchFn>(() => Promise.resolve([null, new IOResult()]))
    await expect(search({} as Accessor, [PATH], ['query'], context(dispatch))).rejects.toThrow(
      'declined',
    )
  })
})

// Twin of test_mounting_a_store_does_not_register_search.
it('is not registered by mounting a store', async () => {
  const ws = new Workspace(
    {
      '/knowledge': new Mount(new ChromaVFS({ collectionName: 'docs' }), { mode: MountMode.READ }),
    },
    {},
  )
  try {
    expect((await ws.shell('search refunds /knowledge')).exitCode).toBe(127)
  } finally {
    await ws.close()
  }
})

function chroma(vfs: ChromaVFS, name = 'search'): Workspace {
  const ws = new Workspace({ '/knowledge': new Mount(vfs, { mode: MountMode.READ }) })
  ws.registerCli(name, SEARCH)
  return ws
}

// Twin of test_a_refused_option_never_asks_chroma: the line's own grammar
// is a usage error, exit 2; a value the mount cannot take fails like the
// mount, exit 1, ahead of a scope it would have to look up. Either way
// Chroma is not asked.
it.each([
  [
    'search --top-k many refunds /knowledge',
    2,
    "search: invalid int value: 'many' for '--top-k'\nTry 'search --help' for more information.\n",
  ],
  [
    'search --bogus refunds /knowledge',
    2,
    "search: unrecognized option '--bogus'\nTry 'search --help' for more information.\n",
  ],
  ['search --top-k 0 refunds /knowledge', 2, 'search: top-k must be positive\n'],
  ["search '' /knowledge", 2, 'search: query is required\n'],
  [
    'search --method keyword refunds /knowledge',
    1,
    "search: only the 'semantic' method is supported\n",
  ],
  [`search ${'x'.repeat(251)} /knowledge/nope`, 1, 'search: query cannot exceed 250 characters\n'],
])('refuses %s without asking chroma', async (cmd, exitCode, stderr) => {
  vi.mocked(clientMod.fetchPathTree).mockResolvedValue(JSON.stringify({ 'a.md': { size: 1 } }))
  const vfs = new ChromaVFS({ collectionName: 'docs' })
  const asked = vi.spyOn(vfs.accessor, 'getCollection')
  const ws = chroma(vfs)
  try {
    const result = await ws.shell(cmd)
    expect([result.exitCode, result.stderrText]).toEqual([exitCode, stderr])
    expect(asked).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

// Twin of test_a_renamed_install_refuses_under_its_name: installed under
// another name, search refuses under that name, as the parser and the mount
// do.
it.each([
  ["lookup '' /knowledge", 2, 'lookup: query is required\n'],
  ['lookup --top-k 0 refunds /knowledge', 2, 'lookup: top-k must be positive\n'],
  [
    'lookup --bogus refunds /knowledge',
    2,
    "lookup: unrecognized option '--bogus'\nTry 'lookup --help' for more information.\n",
  ],
  [
    'lookup --method keyword refunds /knowledge',
    1,
    "lookup: only the 'semantic' method is supported\n",
  ],
])('refuses %s under the installed name', async (cmd, exitCode, stderr) => {
  vi.mocked(clientMod.fetchPathTree).mockResolvedValue(JSON.stringify({ 'a.md': { size: 1 } }))
  const ws = chroma(new ChromaVFS({ collectionName: 'docs' }), 'lookup')
  try {
    const result = await ws.shell(cmd)
    expect([result.exitCode, result.stderrText]).toEqual([exitCode, stderr])
  } finally {
    await ws.close()
  }
})

// Twin of test_a_failure_names_search.
it('names search in a failure', async () => {
  vi.mocked(clientMod.fetchPathTree).mockResolvedValue(JSON.stringify({ 'a.md': { size: 1 } }))
  const vfs = new ChromaVFS({ collectionName: 'docs' })
  const down = {
    get: () => Promise.resolve({ ids: [], documents: [], metadatas: [] }),
    query: () => Promise.reject(new Error('chroma is down')),
  }
  vi.spyOn(vfs.accessor, 'getCollection').mockResolvedValue(
    down as unknown as Awaited<ReturnType<typeof vfs.accessor.getCollection>>,
  )
  const ws = chroma(vfs)
  try {
    const missing = await ws.shell('search refunds /knowledge/nope')
    const failed = await ws.shell('search refunds /knowledge')
    expect([missing.exitCode, missing.stderrText]).toEqual([
      1,
      'search: /knowledge/nope: No such file or directory\n',
    ])
    expect([failed.exitCode, failed.stderrText]).toEqual([1, 'search: chroma is down\n'])
  } finally {
    await ws.close()
  }
})

function dify(): { ws: Workspace; posted: unknown[] } {
  const posted: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { body?: string }) => {
      posted.push(init.body === undefined ? { listed: url } : JSON.parse(init.body))
      return Promise.resolve(
        new Response(JSON.stringify({ records: [], data: [], has_more: false })),
      )
    }),
  )
  const ws = new Workspace({
    '/knowledge/': new DifyVFS({
      apiKey: 'key',
      baseUrl: 'https://dify.test/v1',
      datasetId: 'kb',
    }),
  })
  ws.registerCli('search', SEARCH)
  return { ws, posted }
}

// Twin of test_dify_answers_the_options_a_line_leaves_out.
it('lets Dify answer the options a line leaves out', async () => {
  const { ws, posted } = dify()
  try {
    expect((await ws.shell('search anything /knowledge')).exitCode).toBe(0)
    expect(posted).toEqual([
      {
        query: 'anything',
        retrieval_model: {
          search_method: 'semantic_search',
          top_k: 10,
          score_threshold_enabled: false,
          score_threshold: 0,
          reranking_enable: false,
        },
      },
    ])
  } finally {
    await ws.close()
  }
})

// Twin of test_dify_is_not_asked_for_an_option_it_refuses: a scope below
// the root is looked up in the document list, so a refused option is caught
// before that listing as well as before the search.
describe.each(['/knowledge', '/knowledge/guides'])('over %s', (scope) => {
  it.each([
    ["--method ''", 1, 'method must be one of'],
    ['--method vector', 1, 'method must be one of'],
    ['--method constructor', 1, 'method must be one of'],
    ['--method toString', 1, 'method must be one of'],
    ['--threshold 1.2', 1, 'threshold must be in [0, 1]'],
    ['--top-k 0', 2, 'top-k must be positive'],
  ])('does not ask Dify for %s', async (options, exitCode, stderr) => {
    const { ws, posted } = dify()
    try {
      const result = await ws.shell(`search ${options} anything ${scope}`)
      expect(result.exitCode).toBe(exitCode)
      expect(result.stderrText).toContain(stderr)
      expect(posted).toEqual([])
    } finally {
      await ws.close()
    }
  })
})
