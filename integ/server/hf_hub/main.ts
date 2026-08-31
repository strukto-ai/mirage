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

import { emit, parseFlagPort, serve } from '../kit/typescript/index.ts'
import { startHubArms } from './arms.ts'
import { hfHubFake } from './fake.ts'

// TWO arms, one store. The REST arm is what a mirage `hf` mount and the `hf`
// CLI talk to; the MCP arm is what an agent harness talks to, and it exists
// because HuggingFace ships no server anyone can vendor -- notion's arm is the
// real upstream server pointed at the fake, so notion's main.ts starts nothing.
// Here `mcp.ts` IS the server, so a harness that cannot spawn a process cannot
// reach it at all, which is what this entry point fixes.
//
// Both arms are announced. A consumer picks by transport: toolathlon's server
// builder returns `{"url": ...}` for an HTTP MCP server and `{"command": ...}`
// for a stdio one, so HF_MCP_URL is the value that builder needs and the REST
// token stays first for the runners, which read the first line.
const MCP_PORT_FLAG = '--mcp-port'

const started = await serve(hfHubFake, [MCP_PORT_FLAG])
const arms = await startHubArms(
  started.runtime,
  parseFlagPort(MCP_PORT_FLAG, process.argv.slice(2)),
)
for (const a of arms.announces) emit(a)
