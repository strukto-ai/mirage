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
  DatabricksVolumeResource,
  MountMode,
  Workspace,
  normalizeDatabricksVolumeConfig,
} from "@struktoai/mirage-node";

const CHUNK_SIZE = 8192;
const DATA = new Uint8Array(CHUNK_SIZE * 3).fill(120);

class FetchProbe {
  bytesRead = 0;
  sourceClosed = false;

  async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(DATA.byteLength) },
      });
    }
    if (method !== "GET") throw new Error(`unexpected method: ${method}`);
    const stream = new ReadableStream<Uint8Array>(new ProbeSource(this), {
      highWaterMark: 0,
    });
    return new Response(stream, { status: 200 });
  }
}

class ProbeSource implements UnderlyingDefaultSource<Uint8Array> {
  private offset = 0;
  private readonly probe: FetchProbe;

  constructor(probe: FetchProbe) {
    this.probe = probe;
  }

  pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.offset >= DATA.byteLength) {
      controller.close();
      this.probe.sourceClosed = true;
      return;
    }
    const chunk = DATA.slice(this.offset, this.offset + CHUNK_SIZE);
    this.offset += chunk.byteLength;
    this.probe.bytesRead += chunk.byteLength;
    controller.enqueue(chunk);
  }

  cancel(): void {
    this.probe.sourceClosed = true;
  }
}

async function waitForDrains(ws: Workspace): Promise<void> {
  const tasks = ws.cache.drainTasks;
  if (tasks === undefined) throw new Error("cache does not expose drain tasks");
  while (tasks.size > 0) {
    await Promise.all([...tasks.values()]);
  }
}

async function main(): Promise<void> {
  const probe = new FetchProbe();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = probe.fetch.bind(probe);
  const resource = await DatabricksVolumeResource.create(
    normalizeDatabricksVolumeConfig({
      catalog: "catalog",
      schema: "schema",
      volume: "volume",
      host: "https://databricks.test",
      token: "token",
    }),
  );
  const ws = new Workspace({ "/dbx/": resource }, { mode: MountMode.READ });
  const path = "/dbx/sample.bin";
  ws.maxDrainBytes = 4096;
  try {
    const result = await ws.execute(`cat ${path} | head -c 100`);
    await waitForDrains(ws);
    const cached = await ws.cache.get(path);
    if (result.stdout.byteLength !== 100) {
      throw new Error(`expected 100 output bytes, got ${String(result.stdout.byteLength)}`);
    }
    if (probe.bytesRead !== CHUNK_SIZE) {
      throw new Error(`expected one 8192-byte read, got ${String(probe.bytesRead)}`);
    }
    if (!probe.sourceClosed) throw new Error("bounded drain left the source open");
    if (cached !== null) throw new Error("bounded drain populated the cache");
    process.stdout.write("=== databricks_volume:bounded_drain ===\n");
    process.stdout.write(
      `bytes=${String(probe.bytesRead)} cache_entry=False source_closed=True\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
