import { afterEach, expect, it, vi } from 'vitest'
import { DevVFS } from '../../../vfs/dev/dev.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'

afterEach(() => vi.restoreAllMocks())

it.each([
  ['cat <(printf first) <(printf second)', 0, 'firstsecond', 2],
  ['cat <(printf first) >(cat)', 2, '', 1],
  ['set -u; cat <(printf first) "$missing"', 127, '', 1],
] as const)('releases prepared inputs after %s', async (line, code, output, count) => {
  const allocated = vi.spyOn(DevVFS.prototype, 'allocateInput')
  const released = vi.spyOn(DevVFS.prototype, 'releaseInput')
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  try {
    const result = await ws.shell(line)
    expect([result.exitCode, result.stdoutText]).toEqual([code, output])
    const inputs = allocated.mock.results.map((result) => result.value as readonly [string, number])
    expect(inputs).toHaveLength(count)
    expect(new Set(inputs.map(([path]) => path)).size).toBe(count)
    expect(released.mock.calls).toEqual(inputs)
  } finally {
    await ws.close()
  }
})
