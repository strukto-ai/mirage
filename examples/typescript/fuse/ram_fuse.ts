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

import { readdirSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  Mount,
  MountMode,
  RAMResource,
  Workspace,
} from "@struktoai/mirage-node";

const DATA_DIR = fileURLToPath(new URL("../../../data/", import.meta.url));

async function main(): Promise<void> {
  const resource = new RAMResource();

  // Seed the RAM resource with files from repo's data/ directory
  const entries = readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const e of entries) {
    const raw = readFileSync(join(DATA_DIR, e.name));
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    resource.store.files.set("/" + e.name, bytes);
    resource.store.dirs.add("/");
  }

  console.log(
    `Loaded ${String(resource.store.files.size)} files from ${DATA_DIR}`,
  );
  for (const name of [...resource.store.files.keys()].sort()) {
    const size = resource.store.files.get(name)?.byteLength ?? 0;
    console.log(`  ${name} (${size.toLocaleString("en-US")} bytes)`);
  }

  const ws = new Workspace({
    "/data/": new Mount(resource, { mode: MountMode.WRITE, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`\n=== FUSE MODE: mounted at ${mp} ===\n`);

    const dataPath = mp;
    console.log("--- real fs.promises.readdir() ---");
    const entries = (await readdir(dataPath)).sort();
    for (const name of entries) {
      const full = `${dataPath}/${name}`;
      const st = await stat(full);
      console.log(
        `  ${name.padEnd(30)} ${st.size.toLocaleString("en-US").padStart(10)} bytes`,
      );
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and try:");
    console.log(`>>>   ls -la ${mp}/`);
    console.log(`>>>   cat ${mp}/example.json | jq .`);
    console.log(">>> Press Enter to unmount and exit...");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
