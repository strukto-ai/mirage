import { afterEach, expect, it, vi } from 'vitest'
import { decodeBase64 } from '../../utils/base64.ts'
import { TokenManager } from '../google/client.ts'
import { sendMessage } from './send.ts'

afterEach(() => vi.unstubAllGlobals())

it('sends a UTF-8 body with legal MIME lines and refuses multi-line headers', async () => {
  const post = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', post)
  const tm = new TokenManager({ accessToken: 'token' })
  const body = 'café ☕'.repeat(40)
  await sendMessage(tm, 'reader@example.org', 'Hello', body)
  const posted = post.mock.calls[0]?.[1]?.body
  if (typeof posted !== 'string') throw new Error('expected a JSON message body')
  const { raw } = JSON.parse(posted) as { raw: string }
  const mime = new TextDecoder().decode(decodeBase64(raw.replaceAll('-', '+').replaceAll('_', '/')))
  const [headers, encoded = ''] = mime.split('\r\n\r\n')
  expect(headers).toContain('Content-Transfer-Encoding: base64')
  const lines = encoded.split('\r\n')
  expect(lines.every((line) => line.length <= 76)).toBe(true)
  expect(new TextDecoder().decode(decodeBase64(lines.join('')))).toBe(body)
  await expect(sendMessage(tm, 'reader@example.org', 'one\r\ntwo', body)).rejects.toThrow()
  expect(post).toHaveBeenCalledTimes(1)
})
