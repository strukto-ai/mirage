import { Accessor } from './base.ts'
import {
  resolveMem0Config,
  type Mem0Config,
  type Mem0ConfigResolved,
} from '../resource/mem0/config.ts'
import { md5Hex } from '../utils/hash.ts'

const ENCODER = new TextEncoder()

export class Mem0Error extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Mem0 request failed with status ${String(status)}`)
    this.name = 'Mem0Error'
    this.status = status
  }
}

export class Mem0Accessor extends Accessor {
  readonly config: Mem0ConfigResolved

  constructor(config: Mem0Config) {
    super()
    this.config = resolveMem0Config(config)
  }

  async request(
    method: string,
    endpoint: string,
    options: { params?: Record<string, string | number>; json?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.config.host + endpoint)
    for (const [name, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(name, String(value))
    }
    // Python drives mem0 through the official SDK; this is a hand-rolled
    // fetch client, so it has to send what the SDK sends. `Mem0-User-ID` is
    // the SDK's own client identifier, md5 of the API key
    // (`mem0/client/main.py`: `hashlib.md5(self.api_key.encode()).hexdigest()`).
    // It is an identifier the server expects, not a credential, so do not
    // "fix" the hash away.
    const headers: Record<string, string> = {
      Authorization: `Token ${this.config.apiKey}`,
      'Mem0-User-ID': md5Hex(ENCODER.encode(this.config.apiKey)),
    }
    const init: RequestInit = { method, headers }
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.json)
    }
    const response = await fetch(url, init)
    if (!response.ok) throw new Mem0Error(response.status)
    const payload: unknown = await response.json()
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Mem0 response must be a JSON object')
    }
    return payload as Record<string, unknown>
  }
}
