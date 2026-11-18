import { stallTimeout } from '../core/api/client.ts'
import { ApiError } from '../core/api/errors.ts'
import { md5Hex } from '../utils/hash.ts'
import { Mem0Config } from '../vfs/mem0/config.ts'
import { Accessor } from './base.ts'

const ENCODER = new TextEncoder()

export class Mem0Error extends ApiError {
  declare readonly status: number
  constructor(status: number) {
    super(`Mem0 request failed with status ${String(status)}`, status)
    this.name = 'Mem0Error'
  }
}

export class Mem0Accessor extends Accessor {
  readonly config: ReturnType<typeof Mem0Config.parse>
  readonly scopeFilter: Record<string, string>

  constructor(config: Mem0Config) {
    super()
    this.config = Mem0Config.parse(config)
    const { userId, agentId, runId } = this.config
    if (userId !== null) this.scopeFilter = { user_id: userId }
    else if (agentId !== null) this.scopeFilter = { agent_id: agentId }
    else if (runId !== null) this.scopeFilter = { run_id: runId }
    else throw new Error('validated Mem0Config has no scope')
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
    const response = await stallTimeout(this.config.timeout)(url, init)
    if (!response.ok) throw new Mem0Error(response.status)
    const payload: unknown = await response.json()
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Mem0 response must be a JSON object')
    }
    return payload as Record<string, unknown>
  }
}
