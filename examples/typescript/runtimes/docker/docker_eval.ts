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

// A docker container as an evaluator: inputs in, the last expression's
// value out, over the result envelope (JSON behind a sentinel on
// stdout). Any runtime with the evaluator capability can also serve as
// the workspace's routing policy engine. Start the container first:
//
//     docker run -d --name mirage-eval-demo python:3.12-slim sleep infinity
//
// and remove it when done: docker rm -f mirage-eval-demo

import { DockerRuntime, EvalError } from '@struktoai/mirage-node'

const CONTAINER = 'mirage-eval-demo'

async function main(): Promise<void> {
  const runtime = new DockerRuntime({ config: { container: CONTAINER } })

  const result = await runtime.eval(
    "print('computing inside the container')\n" + "sum(ctx['xs']) * ctx['factor']",
    { inputs: { ctx: { xs: [1, 2, 3], factor: 7 } } },
  )
  console.log(`value: ${JSON.stringify(result.value)}`)
  console.log(`container stdout: ${JSON.stringify(new TextDecoder().decode(result.stdout))}`)

  try {
    await runtime.eval('1 / 0')
  } catch (err) {
    if (!(err instanceof EvalError)) throw err
    const lastLine = err.message.trim().split('\n').at(-1)
    console.log(`remote failure surfaces as EvalError: ${lastLine}`)
  }

  await runtime.close()
}

await main()
