import { expect, it } from 'vitest'

import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { VERSION } from '../../../../version.ts'
import { GH } from './index.ts'

it.each(['version', '--version'])(
  'reports the version without a mount or API: %s',
  async (form) => {
    const ws = new Workspace({})
    ws.registerCli('gh', GH, { token: 'unused', base_url: 'http://127.0.0.1:1' })
    try {
      const result = await ws.shell(`gh ${form}`)
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toBe(`gh version ${VERSION} (Mirage)\n`)
      expect(result.stderr).toHaveLength(0)
    } finally {
      await ws.close()
    }
  },
)
