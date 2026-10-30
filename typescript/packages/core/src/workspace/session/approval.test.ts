import { describe, expect, it } from 'vitest'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import type { RecordFields } from '../record/types.ts'
import { SessionManager } from './manager.ts'
import { SessionState } from './session.ts'
import { seedVar } from './state.ts'
import { approvalSession, transactApprovals } from './approval.ts'

function question(ticket = 'request'): RecordFields {
  const rule = {
    reason: Array.from('review', (c) => c.charCodeAt(0)),
    commands: [],
    paths: [],
    mount: [],
  }
  return {
    op: 'resolve',
    question: {
      id: ticket,
      session_id: 's',
      command: [103, 105, 116],
      argv: [],
      cwd: [47],
      paths: [],
      reason: rule.reason,
      rule,
    },
    rules: [rule],
    claimant: null,
  }
}

it('preserves an inherited shown-path mode when decoding policy facts', () => {
  const restored = approvalSession({
    session_id: 's',
    shown_paths: { entries: [{ path: '/data' }] },
  })
  expect(restored.visibility.shown?.entries[0]?.mode).toBeNull()
  expect(restored.toDict().shown_paths).toEqual({ entries: [{ path: '/data' }] })
})

class UncertainStore extends RAMNamespaceStore {
  attempts = 0
  constructor(private readonly commit: boolean) {
    super()
  }
  override async casSet(key: string, fields: RecordFields, expected: number): Promise<boolean> {
    this.attempts++
    if (this.attempts === 1 || !this.commit) {
      if (this.commit) await super.casSet(key, fields, expected)
      throw new Error('write reply lost')
    }
    return super.casSet(key, fields, expected)
  }
}

class RacingStore extends RAMNamespaceStore {
  override async casSet(key: string, fields: RecordFields, expected: number): Promise<boolean> {
    await Promise.resolve()
    return super.casSet(key, fields, expected)
  }
}

async function fresh(store: RAMNamespaceStore) {
  return transactApprovals(store, new SessionState({ sessionId: 's' }).toDict(), question(), null)
}

describe('acknowledged approval storage', () => {
  it('reconfirms a lost first write reply without duplicating the transition', async () => {
    const store = new UncertainStore(true)
    const reply = await fresh(store)
    expect(reply.result.kind).toBe('pending')
    expect(store.attempts).toBe(2)
    expect(await store.get('s')).toMatchObject({
      generation: 2,
      approval_state: { revision: 1, records: [expect.anything()], receipts: [expect.anything()] },
    })
  })

  it('never publishes authority when writes remain unknown', async () => {
    const store = new UncertainStore(false)
    await expect(fresh(store)).rejects.toThrow('storage_unconfirmed')
    expect(await store.get('s')).toBeNull()
  })

  it('allows only one of two competing calls to consume one answer', async () => {
    const store = new RacingStore()
    const pending = await fresh(store)
    const epoch = String(pending.fields.incarnation)
    const answered = await transactApprovals(
      store,
      pending.fields,
      {
        op: 'answer',
        id: 'request',
        outcome: 'allow',
        scope: 'once',
        note: [],
        claimant: null,
      },
      epoch,
    )
    const replies = await Promise.all(
      ['caller-a', 'caller-b'].map((ticket) =>
        transactApprovals(store, answered.fields, question(ticket), epoch),
      ),
    )
    expect(replies.map((reply) => reply.result.kind).sort()).toEqual(['allow', 'pending'])
    expect(await store.get('s')).toMatchObject({
      approval_state: {
        retired: ['request'],
        records: [expect.anything()],
      },
    })
  })

  it('rejects stale policy facts without publishing a transition', async () => {
    const store = new RAMNamespaceStore()
    const pending = await fresh(store)
    const changed = {
      ...structuredClone(pending.fields),
      generation: Number(pending.fields.generation) + 1,
      commands: { allow: [], ask: [], deny: [] },
    }
    await store.set('s', changed)
    await expect(
      transactApprovals(
        store,
        pending.fields,
        question('later'),
        String(pending.fields.incarnation),
      ),
    ).rejects.toThrow('stale_facts')
    expect(await store.get('s')).toEqual(changed)
  })

  it('preserves newer restrictions and approvals during a stale ordinary flush', async () => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('s', store)
    await manager.ensureLoaded()
    await manager.flush()
    await manager.approvalEvent('s', question(), manager.incarnationOf('s'))
    const old = new SessionManager('s', store)
    await old.ensureLoaded()
    const current = await store.get('s')
    if (!current) throw new Error('session was not persisted')
    const newer = {
      ...structuredClone(current),
      generation: Number(current.generation) + 1,
      commands: { allow: [], ask: [], deny: [] },
    }
    await store.set('s', newer)
    seedVar(old.get('s'), 'LOCAL', 'kept')
    await old.flush()
    expect(await store.get('s')).toMatchObject({
      commands: newer.commands,
      env: { LOCAL: 'kept' },
      approval_state: { records: [expect.anything()] },
    })
    expect(old.get('s').commands?.allow).toEqual([])
  })

  it('does not let an old session rejoin a replacement', async () => {
    const store = new RAMNamespaceStore()
    const first = await fresh(store)
    const replacement = {
      ...structuredClone(first.fields),
      incarnation: 'replacement',
      generation: Number(first.fields.generation) + 1,
      approval_state: {
        ...(first.fields.approval_state as RecordFields),
        incarnation: 'replacement',
      },
    }
    await store.set('s', replacement)
    await expect(
      transactApprovals(store, first.fields, question('old'), String(first.fields.incarnation)),
    ).rejects.toThrow('session_replaced')
    expect(await store.get('s')).toEqual(replacement)
  })

  it('refuses approval authority on an unqualified store', async () => {
    class UnqualifiedStore extends RAMNamespaceStore {
      override approvalGuarantee(): Promise<void> {
        return Promise.reject(new Error('unsupported durability'))
      }
    }
    const store = new UnqualifiedStore()
    await expect(fresh(store)).rejects.toThrow('storage_unqualified')
    expect(await store.get('s')).toBeNull()
  })
})

describe('session lifecycle fences', () => {
  it('publishes policy during refresh without publishing unconfirmed scratch state', async () => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('s', store)
    const epoch = await manager.activate('s')
    const session = manager.get('s')
    seedVar(session, 'UNCONFIRMED', 'pending')
    session.commands = { allow: [], ask: [], deny: [] }
    await manager.refreshApproval('s', epoch)
    expect(await store.get('s')).toMatchObject({ commands: { allow: [] } })
    expect(await store.get('s')).not.toMatchObject({ env: { UNCONFIRMED: 'pending' } })
    expect(session.env.UNCONFIRMED).toBe('pending')
  })

  it('does not activate a clean stale session after closure', async () => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('default', store)
    manager.create('s')
    await manager.activate('s')
    const old = new SessionManager('default', store)
    await old.ensureLoaded()
    await manager.close('s')
    await expect(old.activate('s')).rejects.toThrow('session_closed')
  })
  it('fences old writers and explicitly recreates with a fresh identity', async () => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('default', store)
    manager.create('s')
    await manager.flush()
    const old = new SessionManager('default', store)
    await old.ensureLoaded()
    const epoch = old.incarnationOf('s')
    await manager.close('s')
    seedVar(old.get('s'), 'OLD', 'stale')
    await expect(old.flush('s')).rejects.toThrow('session_closed')
    const fresh = new SessionManager('default', store)
    await fresh.ensureLoaded()
    expect(fresh.has('s')).toBe(false)
    fresh.create('s')
    await fresh.flush('s')
    expect(fresh.incarnationOf('s')).not.toBe(epoch)
    await expect(old.flush('s')).rejects.toThrow('session_replaced')
    expect(await store.get('s')).not.toMatchObject({ env: { OLD: 'stale' } })
  })

  it('invalidates answers and fences old holders after snapshot restore', async () => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('s', store)
    await manager.ensureLoaded()
    await manager.flush()
    const epoch = manager.incarnationOf('s')
    await manager.approvalEvent('s', question(), epoch)
    await manager.approvalEvent(
      's',
      {
        op: 'answer',
        id: 'request',
        outcome: 'allow',
        scope: 'session',
        note: [],
        claimant: null,
      },
      epoch,
    )
    const old = new SessionManager('s', store)
    await old.ensureLoaded()
    const snapshot = manager.get('s').fork()
    await manager.replaceFromSnapshot([snapshot])
    expect(manager.incarnationOf('s')).not.toBe(epoch)
    expect(await store.get('s')).toMatchObject({ approval_state: { records: [] } })
    await expect(old.approvalEvent('s', question('late'), epoch)).rejects.toThrow(
      'session_replaced',
    )
  })

  it('keeps an unknown closure blocked until publication is reconfirmed', async () => {
    class LostClosureStore extends RAMNamespaceStore {
      loseReplies = false
      override async casSet(key: string, fields: RecordFields, expected: number): Promise<boolean> {
        const placed = await super.casSet(key, fields, expected)
        if (this.loseReplies) throw new Error('committed but acknowledgement lost')
        return placed
      }
    }
    const store = new LostClosureStore()
    const manager = new SessionManager('default', store)
    manager.create('s')
    await manager.flush()
    store.loseReplies = true
    await expect(manager.close('s')).rejects.toThrow('storage_unconfirmed')
    expect(manager.has('s')).toBe(true)
    await expect(
      manager.approvalEvent('s', question(), manager.incarnationOf('s')),
    ).rejects.toThrow('session_transition_pending')
    const marker = await store.get('s')
    store.loseReplies = false
    await manager.close('s')
    expect(manager.has('s')).toBe(false)
    const confirmed = await store.get('s')
    expect(confirmed?.incarnation).toBe(marker?.incarnation)
    expect(Number(confirmed?.generation)).toBeGreaterThan(Number(marker?.generation))
  })
})
