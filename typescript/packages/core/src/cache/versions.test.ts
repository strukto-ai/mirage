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
import { VersionHistory, VersionScope } from './versions.ts'
import { OpRecord } from '../observe/record.ts'
import { SessionState } from '../workspace/session/session.ts'

function record(op = 'read', fingerprint: string | null = 'v1'): OpRecord {
  return new OpRecord({
    op,
    path: '/f',
    source: 's3',
    bytes: 1,
    timestamp: 0,
    durationMs: 0,
    fingerprint,
  })
}

describe('live version history', () => {
  it('isolates sessions and replacement mounts', () => {
    const scope = new VersionScope()
    const a = new VersionHistory()
    const b = new VersionHistory()
    a.observe(scope, '/f', record())
    b.observe(scope, '/f', record('read', 'v2'))
    expect(a.read(scope, '/f')).toBe('v1')
    expect(b.read(scope, '/f')).toBe('v2')
    expect(a.read(new VersionScope(), '/f')).toBeNull()
  })
  it('tracks stream stamps and unknown reads without adopting metadata', () => {
    const history = new VersionHistory()
    const scope = new VersionScope()
    const rec = record('read', null)
    history.observe(scope, '/f', rec)
    rec.fingerprint = 'v1'
    expect(history.read(scope, '/f')).toBe('v1')
    history.observe(scope, '/f', record('stat', 'v2'))
    expect(history.read(scope, '/f')).toBe('v1')
    history.observe(scope, '/f', record('read', null))
    expect(history.read(scope, '/f')).toBeNull()
  })
  it.each(['unlink', 'rename', 'copy', 'append', 'pwrite'])(
    'point mutation %s leaves children',
    (op) => {
      const history = new VersionHistory()
      const scope = new VersionScope()
      history.observe(scope, '/f', record())
      history.observe(scope, '/f/child', record())
      history.observe(scope, '/f', record(op))
      expect(history.read(scope, '/f')).toBeNull()
      expect(history.read(scope, '/f/child')).toBe('v1')
    },
  )
  it('retracts subtrees and pins, retaining individual refusals', () => {
    const history = new VersionHistory()
    const scope = new VersionScope()
    scope.pins.set('/d/pinned', 'snapshot')
    history.observe(scope, '/d/a', record())
    history.observe(scope, '/dog', record())
    history.observe(scope, '/d', record('rm_r'))
    history.keep(scope, '/d/a', 'v1')
    expect(history.read(scope, '/d/a')).toBe('v1')
    expect(history.read(scope, '/d/pinned')).toBeNull()
    expect(history.read(scope, '/dog')).toBe('v1')
    history.keep(scope, '/d/a', null)
    expect(history.read(scope, '/d/a')).toBeNull()
  })
  it('shares shell forks but does not serialize observations', () => {
    const session = new SessionState({ sessionId: 'a' })
    const scope = new VersionScope()
    session.versions.observe(scope, '/f', record())
    expect(session.fork().versions).toBe(session.versions)
    expect(session.subshell().versions).toBe(session.versions)
    const fields = session.toDict()
    expect(fields).not.toHaveProperty('versions')
    expect(
      SessionState.fromDict({ ...fields, session_id: session.sessionId }).versions.read(
        scope,
        '/f',
      ),
    ).toBeNull()
  })
})

it.each(['v1', null])('unstarted reads preserve the previous observation %s', (initial) => {
  const history = new VersionHistory()
  const scope = new VersionScope()
  scope.pins.set('/f', 'snapshot')
  history.keep(scope, '/f', initial)
  let pending = record('read', null)
  for (let i = 0; i < 3; i++) {
    pending = record('read', null)
    pending.bytes = 0
    pending.complete = false
    history.observe(scope, '/f', pending)
    expect(history.read(scope, '/f')).toBe(initial)
  }
  pending.complete = true
  pending.fingerprint = 'empty-file-token'
  expect(history.read(scope, '/f')).toBe('empty-file-token')
  pending = record('read', null)
  pending.bytes = 0
  pending.complete = false
  history.observe(scope, '/f', pending)
  pending.bytes = 1
  expect(history.read(scope, '/f')).toBeNull()
})

it.each([false, true])(
  'completed empty reads can clear an unknown version (stream: %s)',
  (streamed) => {
    const history = new VersionHistory()
    const scope = new VersionScope()
    history.keep(scope, '/f', 'old')
    const rec = record('read', null)
    rec.bytes = 0
    rec.complete = !streamed
    history.observe(scope, '/f', rec)
    if (streamed) {
      expect(history.read(scope, '/f')).toBe('old')
      rec.complete = true
    }
    expect(history.read(scope, '/f')).toBeNull()
  },
)

it('response headers do not advance a read before bytes arrive', () => {
  const history = new VersionHistory()
  const scope = new VersionScope()
  history.keep(scope, '/f', 'old')
  const rec = record('read', 'new')
  rec.bytes = 0
  rec.complete = false
  history.observe(scope, '/f', rec)
  expect(history.read(scope, '/f')).toBe('old')
  rec.complete = true
  expect(history.read(scope, '/f')).toBe('new')
})
