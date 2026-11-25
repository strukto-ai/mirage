import { describe, expect, it } from 'vitest'
import {
  decodeStart,
  encodeMessage,
  endStream,
  InvalidConnectRequest,
  UnsupportedProcessOption,
} from './connect.ts'

function envelope(flags: number, payload: string): Buffer {
  const bytes = Buffer.from(payload)
  const body = Buffer.alloc(5 + bytes.length)
  body[0] = flags
  body.writeUInt32BE(bytes.length, 1)
  bytes.copy(body, 5)
  return body
}

describe('E2B Connect frames', () => {
  it('decodes a framed SDK command', () => {
    const payload = JSON.stringify({
      process: {
        cmd: '/bin/bash',
        args: ['-l', '-c', 'pwd'],
        cwd: '/home/user',
        envs: { TEST: 'value' },
      },
      stdin: false,
    })
    expect(decodeStart(envelope(0, payload))).toEqual({
      line: 'pwd',
      cwd: '/home/user',
      envs: { TEST: 'value' },
      stdin: false,
    })
  })

  it.each([Buffer.from('{}'), envelope(1, '{}'), envelope(0, '{}').subarray(0, -1)])(
    'rejects malformed frames',
    (body) => {
      expect(() => decodeStart(body)).toThrow(InvalidConnectRequest)
    },
  )

  it('encodes separate process-end and stream-end frames', () => {
    expect(Buffer.from(encodeMessage({ end: { exited: true, exitCode: 3 } }))).toEqual(
      envelope(0, '{"event":{"end":{"exited":true,"exitCode":3}}}'),
    )
    expect(Buffer.from(endStream())).toEqual(envelope(2, '{}'))
    expect(Buffer.from(endStream('deadline_exceeded', 'command deadline exceeded'))).toEqual(
      envelope(2, '{"error":{"code":"deadline_exceeded","message":"command deadline exceeded"}}'),
    )
  })

  it('rejects a custom shell as unsupported', () => {
    const body = '{"process":{"cmd":"/bin/sh","args":["-c","pwd"]}}'
    expect(() => decodeStart(envelope(0, body))).toThrow(UnsupportedProcessOption)
  })
})
