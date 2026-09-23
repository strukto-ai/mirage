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
    version: 4,
    mounts: [
      {
        index: 0,
        prefix: '/m',
        mode: 'write',
        read: 'bounded',
        ttl: 45,
        vfs_class: 'ram',
        vfs_ref: './wiki.mjs:WikiVFS',
        vfs_state: {
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
    expect(meta.mounts[0]?.vfsState).not.toHaveProperty('files')
    // The ref is the only locator that rebuilds a class loaded from a
    // script file, so a commit carries it beside the class name.
    expect(meta.mounts[0]?.vfsRef).toBe('./wiki.mjs:WikiVFS')
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
      vfs_state: { files: Record<string, Uint8Array> }
    }[]
    const rs = mounts[0]?.vfs_state
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
    expect(back.mounts[0]?.vfs_ref).toBe('./wiki.mjs:WikiVFS')
  })

  it("carries the mount's read policy and bound through the version meta", () => {
    // Asserted on values the fixture actually sets: with `read` and `ttl`
    // absent from it, the carry-through lines would compare undefined to
    // undefined and pass however they were written.
    const { entries, meta } = treeInputsFromState(makeState())
    expect(meta.mounts[0]?.read).toBe('bounded')
    expect(meta.mounts[0]?.ttl).toBe(45)
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    expect(back.mounts[0]?.read).toBe('bounded')
    expect(back.mounts[0]?.ttl).toBe(45)
    expect(back.version).toBe(4)
  })

  it('echoes the committed format version rather than stamping the current one', () => {
    // Stamping would relabel every old commit as current, so the
    // loader's version refusal could never fire and a v3 commit would
    // land on a missing required key instead of the regenerate message.
    const state = makeState()
    state.version = 3
    const { entries, meta } = treeInputsFromState(state)
    expect(toState(entries, blobToMeta(metaToBlob(meta))).version).toBe(3)
  })

  it('reads a meta with no version key back as unversioned, not as current', () => {
    // Python's twin answers 3 here and TypeScript answers undefined;
    // both then refuse at the loader, with different wording. What must
    // not happen either side is reading it as the current format, which
    // would let a pre-v4 commit past the version check.
    const { entries, meta } = treeInputsFromState(makeState())
    delete (meta as { version?: number }).version
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    expect(back.version).not.toBe(4)
  })

  it('reads a pre-v4 mount meta back without the read keys rather than inventing them', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    for (const mount of meta.mounts) {
      delete mount.read
      delete mount.ttl
    }
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    expect(back.mounts[0]?.read).toBeUndefined()
    expect(back.mounts[0]?.ttl).toBeUndefined()
  })

  it('a meta committed before the ref was recorded reads as constructed in code', () => {
    const { entries, meta } = treeInputsFromState(makeState())
    for (const mount of meta.mounts) delete mount.vfsRef
    const back = toState(entries, blobToMeta(metaToBlob(meta)))
    expect(back.mounts[0]?.vfs_ref).toBeNull()
  })
})
