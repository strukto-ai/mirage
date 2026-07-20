// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { Accessor } from './base.ts'
import type { DifyConfigResolved } from '../resource/dify/config.ts'

export interface DifyRequestOptions {
  params?: Record<string, string | number | boolean>
  json?: unknown
}

class Semaphore {
  private available: number
  private readonly waiters: (() => void)[] = []

  constructor(max: number) {
    this.available = Math.max(1, max)
  }

  async acquire(): Promise<() => void> {
    const release = (): void => {
      this.release()
    }
    if (this.available > 0) {
      this.available -= 1
      return release
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    this.available -= 1
    return release
  }

  private release(): void {
    this.available += 1
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

export class DifyAccessor extends Accessor {
  readonly config: DifyConfigResolved
  private readonly limiter: Semaphore

  constructor(config: DifyConfigResolved) {
    super()
    this.config = config
    this.limiter = new Semaphore(config.maxConcurrency)
  }

  async request(
    method: string,
    endpoint: string,
    options: DifyRequestOptions = {},
  ): Promise<Response> {
    const release = await this.limiter.acquire()
    try {
      return await this.fetch(method, endpoint, options)
    } finally {
      release()
    }
  }

  private fetch(method: string, endpoint: string, options: DifyRequestOptions): Promise<Response> {
    const url = new URL(this.config.baseUrl + endpoint)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
    }
    const init: RequestInit = { method, headers }
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.json)
    }
    const controller = new AbortController()
    init.signal = controller.signal
    const timer = setTimeout(() => {
      controller.abort()
    }, this.config.requestTimeout * 1000)
    return fetch(url, init).finally(() => {
      clearTimeout(timer)
    })
  }
}
