import { expect, it } from 'vitest'
import { renderMail } from '../../rs/stream.ts'
import { compactJsonBytes } from '../render/json.ts'
import { parseRfc822 } from './_parse.ts'
import { Stream, parseMime } from './mime.ts'
import { messageJsonBytes } from './render.ts'

const encode = new TextEncoder()
const shared = [
  'From: Relay <relay@example.test>',
  'To: Editor <editor@example.test>',
  'Date: Fri, 13 Nov 2026 09:10:11 +0700',
  'Received: from relay.example.test (ptr.example.test [192.0.2.1])',
  ' by mail.example.test with ESMTPS id queue-1 for <editor@example.test>;',
  ' Fri, 13 Nov 2026 09:10:11 +0700',
  'Subject: Quarterly report',
  'Content-Type: multipart/mixed; boundary="reports"',
  '',
  '--reports',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Report attached.',
  '--reports',
  'Content-Type: application/pdf',
  "Content-Disposition: attachment; filename*0*=UTF-8''caf%C3%A9;",
  ' filename*1=.pdf',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERg==',
  '--reports--',
  '',
].join('\r\n')

it('renders the structured trace and the continued filename', async () => {
  const raw = encode.encode(shared)
  const message = parseMime(raw)
  expect(message).not.toBeNull()
  expect(await renderMail(raw, { view: 'command_json' })).toEqual(
    compactJsonBytes(message?.asDocument()),
  )
  const flags = ['\\Seen']
  const expected = await parseRfc822(raw)
  expect(await renderMail(raw, { view: 'file', uid: '1', flags })).toEqual(
    messageJsonBytes({ ...expected, uid: '1', flags, internalDate: '', rawSize: raw.length }),
  )
  expect(await renderMail(raw, { view: 'attachment', filename: 'café.pdf' })).toEqual(
    encode.encode('%PDF'),
  )
})

it.each([
  shared.replace('JVBERg==', 'JV!BERg=='),
  shared.replace('--reports--', ''),
  shared.replace('filename*1=.pdf', 'filename*2=.pdf'),
  shared.replace('Content-Type: application/pdf', 'Content-Type: message/rfc822'),
  shared.replace('Quarterly report', '=?UTF-8?Q?No=C3=ABl?='),
  shared.replace('Relay <', 'Relay  Name <'),
  shared.replace('relay@example.test', 'relay@example..test'),
  shared.replace("filename*0*=UTF-8''caf%C3%A9;", 'filename*0=" lead ";'),
])('delegates a message it cannot represent', async (source) => {
  const raw = encode.encode(source)
  expect(await renderMail(raw, { view: 'command_json' })).toBeNull()
  expect(await renderMail(raw, { view: 'file', uid: '1', flags: [] })).toBeNull()
  expect(await renderMail(raw, { view: 'attachment', filename: 'café.pdf' })).toBeNull()
})

it('preserves transfer recovery at a multipart boundary', () => {
  const boundary = encode.encode('item')
  const quoted = new Stream(encode.encode('value \r\n--item--\r\n'))
  expect(quoted.decodeQuotedPrintable(boundary)).toEqual([6, encode.encode('value')])
  const unpadded = new Stream(encode.encode('JVBERg\r\n--item--\r\n'))
  expect(unpadded.decodeBase64(boundary)).toEqual([6, encode.encode('%PD')])
})
