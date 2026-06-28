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

import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  GSlidesResource,
  Mount,
  MountMode,
  Workspace,
  type GSlidesConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({
  path: resolve(__HERE, "../../../.env.development"),
  override: true,
});

function buildConfig(): GSlidesConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  if (clientId === "" || clientSecret === "" || refreshToken === "") {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required",
    );
  }
  return { clientId, clientSecret, refreshToken };
}
async function main(): Promise<void> {
  const resource = new GSlidesResource(buildConfig());
  const ws = new Workspace({
    "/gslides": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log(`--- readdir() ${mp} ---`);
    for (const r of await readdir(mp)) console.log(`  ${r}`);

    console.log(`\n--- readdir() ${mp}/owned (first 5) ---`);
    const owned = await readdir(`${mp}/owned`);
    for (const o of owned.slice(0, 5)) console.log(`  ${o}`);
    if (owned.length > 5) console.log(`  ... (${String(owned.length)} total)`);

    if (owned[0] !== undefined) {
      const path = `${mp}/owned/${owned[0]}`;
      console.log(`\n--- readFile() ${owned[0]} (first 200 chars) ---`);
      const text = await readFile(path, "utf-8");
      console.log(text.slice(0, 200));
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Try in another terminal:");
    console.log(`>>>   ls ${mp}/owned/`);
    console.log(`>>>   cat ${mp}/owned/<file> | jq .title`);
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
