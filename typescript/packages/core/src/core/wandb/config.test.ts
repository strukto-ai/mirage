import { describe, expect, it } from 'vitest'
import { parseConfigWithSchema, redactConfigWithSchema } from '../../vfs/secrets.ts'
import { WandbConfig } from './config.ts'
import { safeName } from './pathing.ts'

describe('W&B config', () => {
  it.each(['', '.', '..', '\0', 'a\0b', 'a/b', 'a\\b', 'lab', '.lab', 'a..b', '...', 'café'])(
    'matches filesystem validation for entity %j',
    (name) => {
      if (safeName(name))
        expect(parseConfigWithSchema(WandbConfig, { entities: [name] }).entities).toEqual([name])
      else expect(() => parseConfigWithSchema(WandbConfig, { entities: [name] })).toThrow()
    },
  )
  it.each([
    { entities: [] },
    { entities: ['a/b'] },
    { entities: ['a'], page_size: 0 },
    { entities: ['a'], max_pages: 0 },
    { entities: ['a'], typo: true },
  ])('refuses invalid config %j', (input) => {
    expect(() => parseConfigWithSchema(WandbConfig, input)).toThrow()
  })
  it('normalizes snake_case and redacts credentials', () => {
    const config = parseConfigWithSchema(WandbConfig, {
      entities: ['lab'],
      api_key: 'private-key',
      page_size: 2,
    })
    expect(config.pageSize).toBe(2)
    expect(JSON.stringify(redactConfigWithSchema(WandbConfig, config))).not.toContain('private-key')
  })
})
