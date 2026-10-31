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

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { fill, runGenerator } from './mcp_to_cli.ts'

// Turns any MCP server into a Mirage virtual CLI: the same commands and JSON
// input as the real CLI mcp_to_cli.ts writes, as a module exporting a `CLI` a
// workspace installs:
//
//   npx tsx mcp_to_mirage.ts --name grafana --out grafana_cli.ts \
//       -- docker run --rm -i -e GRAFANA_URL mcp/grafana -t stdio
//   ws.registerCli('grafana', GRAFANA, { env: { GRAFANA_URL: '...' } })
//
// or, from workspace YAML:
//
//   clis:
//     grafana:
//       cli: ./grafana_cli.ts:GRAFANA
//       config:
//         env: {GRAFANA_URL: "${GRAFANA_URL}"}

export const TEMPLATE = readFileSync(new URL('./mirage_cli.ts.tmpl', import.meta.url), 'utf8')

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runGenerator(({ name, out, server }, tools) => {
    writeFileSync(out, fill(TEMPLATE, name, server, tools))
  })
}
