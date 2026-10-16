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

import { describe, expect, it } from 'vitest'
import { GitHubAccessor } from '../../accessor/github.ts'
import { FileChangeKind, type JsonValue, PathSpec } from '../../types.ts'
import type { GitHubTransport } from './client.ts'
import { GitHubEventHook } from './events.ts'

const ROOT = new PathSpec({ virtual: '/gh', directory: '/gh', vfsPath: '' })

function accessor(): GitHubAccessor {
  const transport: GitHubTransport = {
    get: () => Promise.resolve({}),
    request: () => Promise.resolve({}),
  }
  return new GitHubAccessor({
    transport,
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
  })
}

function push(ref = 'refs/heads/main', extra: Record<string, JsonValue> = {}) {
  return {
    ref,
    repository: { full_name: 'Acme/Proj', default_branch: 'main' },
    commits: [
      { added: ['new.txt', 'tmp.txt'], removed: [], modified: ['a.md'] },
      { added: [], removed: ['tmp.txt', 'old.txt'], modified: ['new.txt'] },
    ],
    ...extra,
  }
}

async function pairs(eventName: string, payload: JsonValue): Promise<[string, string][]> {
  const events = await new GitHubEventHook(accessor()).toEvents(ROOT, eventName, payload)
  return events.map((event) => [event.kind, event.path.virtual])
}

describe('GitHubEventHook', () => {
  // Twin of test_a_push_to_the_mounted_ref_names_each_path_once.
  it('names each path of a push to the mounted ref once', async () => {
    expect(await pairs('push', push())).toEqual([
      [FileChangeKind.CREATE, '/gh/new.txt'],
      [FileChangeKind.UPDATE, '/gh/a.md'],
      [FileChangeKind.DELETE, '/gh/old.txt'],
    ])
  })

  // Twin of test_a_push_elsewhere_or_rewritten_is_skipped_or_unknown.
  it('skips a push elsewhere and calls a rewritten one unknown', async () => {
    expect(await pairs('push', push('refs/heads/dev'))).toEqual([])
    expect(await pairs('issues', push())).toEqual([])
    expect(await pairs('push', { ...push(), repository: { full_name: 'acme/other' } })).toEqual([])
    expect(await pairs('push', push(undefined, { forced: true }))).toEqual([
      [FileChangeKind.UNKNOWN, '/gh'],
    ])
    expect(await pairs('push', push(undefined, { deleted: true }))).toEqual([
      [FileChangeKind.UNKNOWN, '/gh'],
    ])
  })
})
