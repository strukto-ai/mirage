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
import {
  blobToMeta,
  metaToBlob,
  toState,
  treeInputsFromState,
  type WorkspaceStateDict,
} from './stateTree.ts'

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function makeState(): WorkspaceStateDict {
  return {
    version: 1,
    mounts: [
      {
        index: 0,
        prefix: '/m',
        mode: 'write',
        resource_class: 'ram',
        resource_state: {
          type: 'ram',
          files: { '/a.txt': enc('hi'), '/sub/b.txt': enc('bee') },
          dirs: ['/'],
          modified: {},
        },
      },
    ],
    cache: {
      limit: 100,
      entries: [
        { key: 'k', data: enc('CACHE'), fingerprint: null, ttl: null, cached_at: 0, size: 5 },
      ],
    },
    sessions: [
      {
        session_id: 'agent_a',
        cwd: '/sub',
        env: { API_KEY: '@aws:prod-key' },
        mount_modes: { '/m': 'read' },
      },
    ],
    nodes: { '/link.txt': { target: '/m/a.txt' } },
    history: [
      { type: 'COMMAND', command: 'echo hi', timestamp: 123, session: 'agent_a' },
      { type: 'COMMAND', command: 'cat /a.txt', timestamp: 456, session: 'agent_b' },
    ],
    default_session_id: 'agent_a',
  } as unknown as WorkspaceStateDict
}

describe('stateTree', () => {
  it('splits mount files from the .mirage/ control-plane subtree', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    // One history file per session, mirroring the live ObserverStore.
    expect(Object.keys(entries).sort()).toEqual([
      '.mirage/history/agent_a.jsonl',
      '.mirage/history/agent_b.jsonl',
      '.mirage/namespace.json',
      '.mirage/sessions.json',
      'm/a.txt',
      'm/sub/b.txt',
    ])
    expect(entries['m/a.txt']).toEqual(enc('hi'))
    expect(meta.mounts[0]?.resourceState).not.toHaveProperty('files')
    // Cache is the one exclusion: derived and rebuildable.
    expect(meta.cache.entries).toEqual([])
    for (const data of Object.values(entries)) {
      expect(new TextDecoder().decode(data)).not.toContain('CACHE')
    }
  })

  it('round-trips the whole world: files, sessions, nodes, history', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    const mounts = back.mounts as unknown as {
      resource_state: { files: Record<string, Uint8Array> }
    }[]
    const rs = mounts[0]?.resource_state
    expect(rs?.files['/a.txt']).toEqual(enc('hi'))
    expect(rs?.files['/sub/b.txt']).toEqual(enc('bee'))
    expect(Object.keys(rs?.files ?? {}).every((p) => !p.startsWith('/.mirage'))).toBe(true)
    const session = back.sessions[0] as unknown as Record<string, unknown>
    expect(session.cwd).toBe('/sub')
    expect(session.env).toEqual({ API_KEY: '@aws:prod-key' })
    expect(session.mount_modes).toEqual({ '/m': 'read' })
    expect(back.nodes).toEqual({ '/link.txt': { target: '/m/a.txt' } })
    expect((back.history as unknown as Record<string, unknown>[]).map((e) => e.command)).toEqual([
      'echo hi',
      'cat /a.txt',
    ])
    expect(back.default_session_id).toBe('agent_a')
    expect(back.cache.entries).toEqual([])
  })
})
