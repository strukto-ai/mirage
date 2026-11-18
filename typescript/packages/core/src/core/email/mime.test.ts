import { expect, test } from 'vitest'
import { parseAttachments, renderMime } from './mime.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const headers = 'Subject: Sample\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'

test('plain text JSON handles a decoded UTF-8 BOM like the Node parser', () => {
  const raw = encoder.encode(headers + '\uFEFFbody')
  const result = JSON.parse(decoder.decode(renderMime(raw, 'json'))) as {
    parts: { body: unknown }[]
  }
  expect(result.parts[0]?.body).toEqual({ Text: 'body' })
})

test('the default view preserves Node whitespace and size formatting', () => {
  const raw = encoder.encode(headers + 'a'.repeat(1149) + '\uFEFF')
  const result = decoder.decode(renderMime(raw, 'read'))
  expect(result).toContain('[1] text/plain (1.13 KiB)')
  expect(result.endsWith('a'.repeat(1149) + '\n')).toBe(true)
})

interface Projection {
  parts: { headers: { name: unknown }[]; body: unknown }[]
}

test('a decoder that consumed a UTF-16 BOM keeps a second one, like Node', () => {
  const raw = encoder.encode(
    'Content-Type: text/plain; charset=UTF-16\r\nContent-Transfer-Encoding: base64\r\n\r\n//7//kEA\r\n',
  )
  const result = JSON.parse(decoder.decode(renderMime(raw, 'json'))) as Projection
  expect(result.parts[0]?.body).toEqual({ Text: '﻿A' })
})

test('header names follow the reference parser, known names included', () => {
  const raw = encoder.encode(
    'DKIM-Signature: v=1; d=example.com\r\nAuthentication-Results: mx.example.com; dkim=pass\r\nX-Custom: 1\r\n' +
      headers +
      'body',
  )
  const result = JSON.parse(decoder.decode(renderMime(raw, 'json'))) as Projection
  expect(result.parts[0]?.headers.slice(0, 3).map((header) => header.name)).toEqual([
    'dkim_signature',
    'authentication_results',
    { other: 'X-Custom' },
  ])
})

test('an attachment reports the Content-Type field the parser decoded', () => {
  const raw = encoder.encode(
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n' +
      'Content-Type: text/plain\r\nContent-Type: application/octet-stream\r\n' +
      'Content-Disposition: attachment; filename=a.bin\r\n\r\nxyz\r\n--b--\r\n',
  )
  expect(parseAttachments(raw, false).map((row) => row.mime)).toEqual(['application/octet-stream'])
})

test('an attached message still drops its UTF-8 BOM inside a UTF-16 labelled part', () => {
  const raw = encoder.encode(
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n' +
      'Content-Type: message/rfc822; charset=UTF-16\r\n\r\n' +
      headers +
      '﻿inner\r\n--b--\r\n',
  )
  const result = JSON.parse(decoder.decode(renderMime(raw, 'json'))) as {
    parts: { body: unknown }[]
  }
  const nested = result.parts.find(
    (part) => typeof part.body === 'object' && part.body !== null && 'Message' in part.body,
  )?.body as { Message: Projection } | undefined
  expect(nested?.Message.parts[0]?.body).toEqual({ Text: 'inner' })
})

function nested(depth: number): Uint8Array {
  return encoder.encode(
    'Content-Type: message/rfc822\r\n\r\n'.repeat(depth) + 'Subject: x\r\n\r\nbody\r\n',
  )
}

test('a message nested past 64 levels is refused, not a trap', () => {
  const result = JSON.parse(decoder.decode(renderMime(nested(64), 'json'))) as Projection
  expect(result.parts.length).toBeGreaterThan(0)
  for (const depth of [65, 100_000]) {
    expect(() => renderMime(nested(depth), 'read')).toThrow(
      'Message nests more than 64 attached messages',
    )
  }
})
