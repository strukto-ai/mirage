import { describe, expect, it } from 'vitest'
import type { ScopeMatch } from './hierarchy/scope.ts'
import { followedDay, guardDay, parseTime, TimeRange } from './time_range.ts'

const JUNE_1 = Date.parse('2026-06-01T00:00:00Z') / 1000
const JUNE_2 = Date.parse('2026-06-02T00:00:00Z') / 1000

function dayMatch(day: string): ScopeMatch {
  return { kind: 'day', vfsPath: `/c/${day}`, slots: { day }, scope: null, pattern: null }
}

function msgs(...stamps: string[]): { ts: string }[] {
  return stamps.map((ts) => ({ ts }))
}

describe('parseTime', () => {
  it('honors the offset and milliseconds', () => {
    expect(parseTime('2026-06-01T00:00:00Z')).toBe(JUNE_1)
    expect(parseTime('2026-06-01T08:00:00+08:00')).toBe(JUNE_1)
    expect(parseTime('2026-06-01T00:00:00.250Z')).toBe(JUNE_1 + 0.25)
  })

  it.each([
    '2026-06-01',
    '2026-06-01T00:00:00',
    '2026-06-01T00:00:00.000001Z',
    '2026-06-01T24:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-06-01T00:00:00+24:00',
    '2026-06-01T00:00:00+01:60',
  ])('refuses %s', (value) => {
    expect(() => parseTime(value)).toThrow()
  })
})

describe('TimeRange', () => {
  it('is bounded by either end', () => {
    expect(new TimeRange().bounded).toBe(false)
    expect(new TimeRange('2026-06-01T00:00:00Z', null).bounded).toBe(true)
    expect(new TimeRange(null, '2026-06-01T00:00:00Z').bounded).toBe(true)
  })

  it('clips to the overlap', () => {
    const scope = new TimeRange('2026-06-01T01:00:00Z', '2026-06-02T00:00:00Z')
    expect(scope.clip(JUNE_1, JUNE_2 + 3600)).toEqual([JUNE_1 + 3600, JUNE_2])
    expect(new TimeRange().clip(JUNE_1, JUNE_2)).toEqual([JUNE_1, JUNE_2])
  })

  it('clips a partial day', () => {
    const scope = new TimeRange('2026-06-01T01:00:00Z', '2026-06-02T02:00:00Z')
    expect(scope.dayBounds('2026-06-01')).toEqual([JUNE_1 + 3600, JUNE_2])
    expect(scope.dayBounds('2026-06-02')).toEqual([JUNE_2, JUNE_2 + 7200])
  })

  it('refuses a day outside the scope', () => {
    const scope = new TimeRange('2026-06-01T01:00:00Z', '2026-06-02T00:00:00Z')
    expect(() => {
      scope.requireDay('2026-06-01', '/slack/channels/c/2026-06-01')
    }).not.toThrow()
    expect(() => {
      scope.requireDay('2026-06-02', '/slack/channels/c/2026-06-02')
    }).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => {
      scope.requireDay('2026-05-31', '/slack/channels/c/2026-05-31')
    }).toThrow()
  })

  it('stops listing before an exclusive midnight end', () => {
    const scope = new TimeRange('2026-05-31T23:59:59Z', '2026-06-02T00:00:00Z')
    expect(scope.listingDays('2026-05-01', '2026-06-30')).toEqual(['2026-05-31', '2026-06-01'])
  })

  it('clips a listing to a glob span', () => {
    const scope = new TimeRange(null, '2026-06-02T00:00:00Z')
    expect(scope.listingDays('2026-01-01', '2026-06-30', ['2026-05-30', '2026-06-01'])).toEqual([
      '2026-05-30',
      '2026-05-31',
    ])
  })

  it('states both ends in its VFS.md text', () => {
    expect(new TimeRange().vfsMd()).toContain('start_time=unbounded')
    const text = new TimeRange('2026-06-01T00:00:00Z', null).vfsMd()
    expect(text).toContain('start_time=2026-06-01T00:00:00.000Z (inclusive)')
    expect(text).toContain('end_time=unbounded (exclusive)')
  })
})

describe('guardDay', () => {
  it('reads the day slot', async () => {
    const accessor = { timeRange: new TimeRange('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z') }
    await expect(guardDay(accessor, dayMatch('2026-06-01'), '/m/c/2026-06-01')).resolves.toBe(
      undefined,
    )
    expect(() => guardDay(accessor, dayMatch('2026-06-02'), '/m/c/2026-06-02')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    )
  })
})

describe('followedDay', () => {
  const DEC = new TextDecoder()
  const text = (step: IteratorResult<Uint8Array>): string =>
    DEC.decode((step.value as Uint8Array | undefined) ?? new Uint8Array())

  it('prints its last lines, then what lands', async () => {
    const asked: ({ ts: string } | null)[] = []
    const answers = [msgs('3'), [], msgs('4', '5')]
    const it = followedDay(msgs('1', '2'), 1, Date.now() / 1000 + 60, 0.001, (last) => {
      asked.push(last)
      return Promise.resolve(answers.shift() ?? [])
    })
    expect(text(await it.next())).toBe('{"ts":"2"}\n')
    expect(text(await it.next())).toBe('{"ts":"3"}\n')
    expect(text(await it.next())).toBe('{"ts":"4"}\n{"ts":"5"}\n')
    await it.return?.()
    expect(asked).toEqual([{ ts: '2' }, { ts: '3' }, { ts: '3' }])
  })

  it('asks for the whole day while it has none', async () => {
    const asked: ({ ts: string } | null)[] = []
    const it = followedDay<{ ts: string }>([], 5, Date.now() / 1000 + 60, 0.001, (last) => {
      asked.push(last)
      return Promise.resolve(msgs('1'))
    })
    expect(text(await it.next())).toBe('{"ts":"1"}\n')
    await it.return?.()
    expect(asked).toEqual([null])
  })

  it('asks a day that is over once more, then waits to be closed', async () => {
    const asked: ({ ts: string } | null)[] = []
    const it = followedDay(msgs('1'), 0, Date.now() / 1000, 0.001, (last) => {
      asked.push(last)
      return Promise.resolve(asked.length === 1 ? msgs('9') : [])
    })
    expect(text(await it.next())).toBe('{"ts":"9"}\n')
    const idle = it.next()
    await it.return?.()
    expect((await idle).done).toBe(true)
    expect(asked).toEqual([{ ts: '1' }])
  })

  it('closes while an ask waits on the backend', async () => {
    let asked = (): void => undefined
    const stalled = new Promise<void>((resolve) => {
      asked = resolve
    })
    const it = followedDay(msgs('1'), 0, Date.now() / 1000 + 60, 0.001, () => {
      asked()
      return new Promise<{ ts: string }[]>(() => undefined)
    })
    const pull = it.next()
    await stalled
    await it.return?.()
    expect((await pull).done).toBe(true)
  })
})
