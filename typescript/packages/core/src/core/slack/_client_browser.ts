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

import { HttpSlackTransport } from './_client.ts'

export interface BrowserSlackTransportOptions {
  proxyUrl: string
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}

export class BrowserSlackTransport extends HttpSlackTransport {
  constructor(private readonly opts: BrowserSlackTransportOptions) {
    super()
    // Reject query strings and fragments — they would silently corrupt the
    // resolved URL when the endpoint is appended.
    const probe = new URL(opts.proxyUrl, 'http://localhost')
    if (probe.search !== '' || probe.hash !== '') {
      throw new Error(
        `BrowserSlackTransport: proxyUrl must not contain a query string or fragment (got: ${opts.proxyUrl})`,
      )
    }
  }
  protected baseUrl(): string {
    const trimmed = this.opts.proxyUrl.replace(/\/+$/, '')
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    const origin =
      (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost'
    return `${origin}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
  }
  protected async authHeaders(_endpoint?: string): Promise<Record<string, string>> {
    const cb = this.opts.getHeaders
    if (cb === undefined) return {}
    return await cb()
  }
}
