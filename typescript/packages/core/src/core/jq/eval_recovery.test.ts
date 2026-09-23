import { describe, expect, it, vi } from 'vitest'
import { loadJq, type Jq } from 'jq-wasm'
import { jqEval } from './eval.ts'

vi.mock('jq-wasm', () => ({ loadJq: vi.fn() }))

describe('jq evaluator recovery', () => {
  it('reports the input bytes and heap ceiling, then replaces a trapped instance', async () => {
    const trap = new WebAssembly.RuntimeError('Aborted(). Build with -sASSERTIONS for more info.')
    const poisonedRaw = vi.fn(() => {
      throw trap
    })
    const healthyRaw = vi.fn(() => ({ stdout: '42', stderr: '', exitCode: 0 }))
    vi.mocked(loadJq)
      .mockResolvedValueOnce({ raw: poisonedRaw } as unknown as Jq)
      .mockResolvedValueOnce({ raw: healthyRaw } as unknown as Jq)
    const failed = jqEval('é😀', '.')
    await expect(failed).rejects.toThrow('8 bytes of JSON input')
    await expect(failed).rejects.toThrow('256 MiB heap limit')
    await expect(failed).rejects.toMatchObject({ cause: trap })
    expect(await jqEval({ ok: 42 }, '.ok')).toEqual([42])
    expect(await jqEval({ ok: 42 }, '.ok')).toEqual([42])
    expect(loadJq).toHaveBeenCalledTimes(2)
    expect(poisonedRaw).toHaveBeenCalledTimes(1)
    expect(healthyRaw).toHaveBeenCalledTimes(2)
    for (const message of [
      'unreachable',
      'memory access out of bounds',
      'Aborted(Assertion failed)',
    ]) {
      const other = new WebAssembly.RuntimeError(message)
      healthyRaw.mockImplementationOnce(() => {
        throw other
      })
      vi.mocked(loadJq).mockResolvedValueOnce({ raw: healthyRaw } as unknown as Jq)
      const failed = jqEval(null, '.')
      await expect(failed).rejects.toThrow(message)
      await expect(failed).rejects.not.toThrow('256 MiB')
      await expect(failed).rejects.not.toThrow('Reduce the input')
      await expect(failed).rejects.toMatchObject({ cause: other })
      expect(await jqEval({ ok: 42 }, '.ok')).toEqual([42])
    }
    expect(loadJq).toHaveBeenCalledTimes(5)
  })
})
