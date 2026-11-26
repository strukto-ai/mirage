import type { JsonValue } from '@struktoai/mirage-core/types'

import { InvalidConnectRequest, UnsupportedProcessOption } from './errors.ts'

export interface StartCommand {
  readonly line: string
  readonly cwd: string | null
  readonly envs: Readonly<Record<string, string>>
  readonly stdin: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

export function decodeStart(body: Uint8Array): StartCommand {
  if (
    body.byteLength < 5 ||
    body[0] !== 0 ||
    new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1) !== body.byteLength - 5
  ) {
    throw new InvalidConnectRequest('expected one uncompressed Connect message')
  }

  let request: unknown
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(5)))
  } catch (error) {
    throw new InvalidConnectRequest('invalid Connect JSON message', { cause: error })
  }
  if (!isRecord(request)) {
    throw new InvalidConnectRequest('expected a process start request')
  }
  if (request.pty != null) throw new UnsupportedProcessOption('PTY commands are unsupported')
  if (request.tag != null) throw new UnsupportedProcessOption('command tags are unsupported')
  if (request.stdin != null && typeof request.stdin !== 'boolean') {
    throw new InvalidConnectRequest('stdin must be a boolean')
  }

  const { process } = request
  if (!isRecord(process)) {
    throw new InvalidConnectRequest('expected a process configuration')
  }
  const { cmd, args, cwd } = process
  if (
    typeof cmd !== 'string' ||
    cmd === '' ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  ) {
    throw new InvalidConnectRequest('expected a shell and its arguments')
  }
  const [login, option, line] = args
  if (
    cmd !== '/bin/bash' ||
    args.length !== 3 ||
    login !== '-l' ||
    option !== '-c' ||
    line === undefined
  ) {
    throw new UnsupportedProcessOption('only the default SDK Bash shell is supported')
  }
  if (cwd != null && typeof cwd !== 'string') {
    throw new InvalidConnectRequest('cwd must be a string')
  }
  const envs = process.envs ?? {}
  if (!isStringMap(envs)) {
    throw new InvalidConnectRequest('environment values must be strings')
  }
  return { line, cwd: cwd ?? null, envs, stdin: request.stdin === true }
}

function encode(flags: number, value: Record<string, JsonValue>): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value))
  const frame = new Uint8Array(5 + payload.byteLength)
  frame[0] = flags
  new DataView(frame.buffer).setUint32(1, payload.byteLength)
  frame.set(payload, 5)
  return frame
}

export function encodeMessage(event: Record<string, JsonValue>): Uint8Array {
  return encode(0, { event })
}

export function endStream(code?: string, message = ''): Uint8Array {
  if (code === undefined) return encode(2, {})
  return encode(2, { error: { code, message } })
}
