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

// The URL facts tvly 1.0.2 reads off WHATWG's URL (src/ui/text.ts and
// src/ui/render/crawl.ts; MIT, see licenses/third_party/tavily-cli.txt): the
// host a saved file is named after and the slug a crawled page is saved under.

/** The parts of a special-scheme URL tvly reads. */
export interface ParsedURL {
  hostname: string
  host: string
  pathname: string
  search: string
}

const SPECIAL = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:'])

/**
 * A URL with a special scheme (http, https, ws, wss, ftp), split by WHATWG's
 * parser; null when it would not parse. The python twin reproduces the parts
 * this reads.
 */
export function parseUrl(url: string): ParsedURL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!SPECIAL.has(parsed.protocol)) return null
  return {
    hostname: parsed.hostname,
    host: parsed.host,
    pathname: parsed.pathname,
    search: parsed.search,
  }
}

/** The URL's host without its port, empty when it does not parse. */
export function hostnameOf(url: string): string {
  return parseUrl(url)?.hostname ?? ''
}

/** The URL's host with any port, the input when it does not parse. */
export function hostOf(url: string): string {
  return parseUrl(url)?.host ?? url
}

/**
 * `<host><path><query>` with anything outside `[\p{L}\p{N}_.-]` as `_`,
 * trimmed of `_`; `index` when that leaves nothing.
 */
export function pageSlug(url: string): string {
  const parsed = parseUrl(url)
  const location =
    parsed === null ? url : parsed.host + parsed.pathname.replace(/\/+$/, '') + parsed.search
  return location.replace(/[^\p{L}\p{N}_\-.]/gu, '_').replace(/^_+|_+$/g, '') || 'index'
}
