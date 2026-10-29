import { describe, expect, it } from 'vitest'
import { SlackConfigSchema } from '../vfs/slack/config.ts'
import { DiscordConfigSchema } from '../vfs/discord/config.ts'
import { GCalConfigSchema } from '../vfs/gcal/config.ts'
import { parseConfigWithSchema } from '../vfs/secrets.ts'

type Input = Record<string, unknown>

describe('mount time bounds', () => {
  for (const [name, normalize, credentials] of [
    ['slack', (c: Input) => parseConfigWithSchema(SlackConfigSchema, c), { token: 'test' }],
    ['discord', (c: Input) => parseConfigWithSchema(DiscordConfigSchema, c), { token: 'test' }],
    ['gcal', (c: Input) => parseConfigWithSchema(GCalConfigSchema, c), { access_token: 'test' }],
  ] as const) {
    it(`${name} validates both bounds through snake_case config`, () => {
      expect(
        normalize({
          ...credentials,
          start_time: '2026-06-01T10:00:00+08:00',
          end_time: '2026-06-01T03:00:00Z',
        }).startTime,
      ).toBe('2026-06-01T10:00:00+08:00')
      expect(normalize({ ...credentials, start_time: null, end_time: null }).endTime).toBeNull()
      for (const [start, end] of [
        ['2026-06-01', null],
        ['2026-06-01T10:00:00', null],
        ['2026-02-30T10:00:00Z', null],
        ['2026-06-01T24:00:00Z', null],
        ['2026-02-30T10:00:00Z', null],
        ['2026-06-01T10:00:00+01:60', null],
        ['2026-02-30T10:00:00Z', null],
        ['0000-06-01T10:00:00Z', null],
        ['2026-06-01T10:00:00.000001Z', null],
        ['2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z'],
        ['2026-06-01T10:00:00Z', '2026-06-01T10:00:00+08:00'],
      ])
        expect(() => normalize({ ...credentials, start_time: start, end_time: end })).toThrow()
    })
  }
})
