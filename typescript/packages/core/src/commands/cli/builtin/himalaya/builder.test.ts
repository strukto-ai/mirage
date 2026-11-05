import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { mixedBoundary } from './builder.ts'

it('preserves multipart boundary framing for Unicode text and binary attachments', () => {
  const body = 'message α 🚀'
  const attachments = [
    {
      filename: 'résumé.bin',
      contentType: 'application/octet-stream',
      data: new Uint8Array([0, 255, 128]),
    },
    { filename: 'empty.txt', contentType: 'text/plain', data: new Uint8Array() },
  ]
  const expected = createHash('sha256').update(body)
  for (const attachment of attachments) {
    expected.update(attachment.filename).update(attachment.contentType).update(attachment.data)
  }
  expect(mixedBoundary(body, attachments)).toBe(expected.digest('hex').slice(0, 32))
})
