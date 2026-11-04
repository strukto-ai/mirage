import { expect, it, vi } from 'vitest'
import { getAttachment } from './messages.ts'
import { TokenManager } from '../google/client.ts'

it('sizes an attachment JSON cap from its decoded size', async () => {
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('{"data":"aGVsbG8gd29ybGQ"}'))
  vi.stubGlobal('fetch', fetchFn)
  const tm = new TokenManager({ accessToken: 'token' })
  try {
    expect(await getAttachment(tm, 'msg1', 'att1', 11)).toEqual(
      new TextEncoder().encode('hello world'),
    )
    fetchFn.mockResolvedValueOnce(new Response(' '.repeat(1040)))
    await expect(getAttachment(tm, 'msg1', 'att1', 11)).rejects.toMatchObject({ limit: 1039 })
  } finally {
    vi.unstubAllGlobals()
  }
})
