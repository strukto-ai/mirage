import { expect, it, vi } from 'vitest'
import { parseConfigWithSchema } from '../../vfs/secrets.ts'
import { WandbClient } from './client.ts'
import { WandbConfig } from './config.ts'
import { RUN_CONFIG, RUN_EXISTS, RUN_SUMMARY } from './queries.ts'

it.each([RUN_EXISTS, RUN_CONFIG, RUN_SUMMARY])(
  'binds run identifiers as variables: %s',
  async (query) => {
    const identifier = 'run") { user { email } } #'
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { project: { run: { name: identifier } } } })),
      )
    vi.stubGlobal('fetch', request)
    try {
      const client = new WandbClient(parseConfigWithSchema(WandbConfig, { entities: ['lab'] }))
      const variables = { entity: 'lab', project: 'project', run: identifier }
      expect((await client.run(variables, query)).name).toBe(identifier)
      const options = request.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(options.body as string) as { query: string; variables: unknown }
      expect(body.variables).toEqual(variables)
      expect(body.query).toBe(query)
      expect(body.query).not.toContain(identifier)
    } finally {
      vi.unstubAllGlobals()
    }
  },
)
