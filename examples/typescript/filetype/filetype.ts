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

import {
  command,
  IOResult,
  MountMode,
  RAMResource,
  SPECS,
  Workspace,
  type CommandFnResult,
  type PathSpec,
} from '@struktoai/mirage-node'

const MAGIC = 'TALLY1'
const dec = new TextDecoder()
const enc = new TextEncoder()

function encode(counts: Record<string, number>): Uint8Array {
  const body = enc.encode(JSON.stringify(counts, Object.keys(counts).sort()))
  const head = new Uint8Array(MAGIC.length + 4)
  head.set(enc.encode(MAGIC))
  new DataView(head.buffer).setUint32(MAGIC.length, body.length, true)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

async function tallyCat(ws: Workspace, paths: PathSpec[]): Promise<CommandFnResult> {
  const path = paths[0]
  if (path === undefined) return [null, new IOResult({ exitCode: 1 })]
  const raw = await ws.fs.readFile(path.virtual)
  if (dec.decode(raw.subarray(0, MAGIC.length)) !== MAGIC) {
    return [null, new IOResult({ exitCode: 1, stderr: enc.encode('cat: not a tally file\n') })]
  }
  const size = new DataView(raw.buffer, raw.byteOffset).getUint32(MAGIC.length, true)
  const body = JSON.parse(
    dec.decode(raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + size)),
  ) as Record<string, number>
  const out = Object.entries(body)
    .map(([k, v]) => `${k} ${String(v)}\n`)
    .join('')
  return [enc.encode(out), new IOResult({ cache: [path.mountPath] })]
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })

  await ws.fs.writeFile('/data/hits.tally', encode({ alpha: 3, beta: 11 }))
  await ws.fs.writeFile('/data/notes.txt', enc.encode('plain text\n'))

  const [tally] = command({
    name: 'cat',
    resource: 'ram',
    spec: SPECS.cat,
    filetype: '.tally',
    fn: (_accessor, paths) => tallyCat(ws, paths),
  })
  if (tally === undefined) throw new Error('command() returned nothing')
  ws.mount('/data')?.register(tally)

  // .tally routes to the renderer above; .txt falls back to the generic cat.
  process.stdout.write(dec.decode((await ws.execute('cat /data/hits.tally')).stdout))
  process.stdout.write(dec.decode((await ws.execute('cat /data/notes.txt')).stdout))

  // The renderer composes with the rest of the shell like any other command.
  const out = await ws.execute('cat /data/hits.tally | sort -k2 -n | tail -1')
  console.log('largest:', dec.decode(out.stdout).trim())
}

await main()
