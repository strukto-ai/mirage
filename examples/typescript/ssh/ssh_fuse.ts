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
  Mount,
  MountMode,
  SSHResource,
  type SSHConfig,
  Workspace,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__HERE, "../../../.env.development") });

function buildConfig(): SSHConfig {
  const host = process.env.SSH_HOST;
  const username = process.env.SSH_USER;
  if (host === undefined || host === "")
    throw new Error("SSH_HOST env var is required");
  if (username === undefined || username === "")
    throw new Error("SSH_USER env var is required");
  const cfg: SSHConfig = { host, username };
  if (process.env.SSH_KEY !== undefined && process.env.SSH_KEY !== "") {
    cfg.identityFile = process.env.SSH_KEY;
  }
  if (process.env.SSH_PASSWORD !== undefined)
    cfg.password = process.env.SSH_PASSWORD;
  if (process.env.SSH_PASSPHRASE !== undefined)
    cfg.passphrase = process.env.SSH_PASSPHRASE;
  if (process.env.SSH_PORT !== undefined && process.env.SSH_PORT !== "") {
    cfg.port = Number(process.env.SSH_PORT);
  }
  if (process.env.SSH_ROOT !== undefined && process.env.SSH_ROOT !== "") {
    cfg.root = process.env.SSH_ROOT;
  }
  return cfg;
}

async function main(): Promise<void> {
  const resource = new SSHResource(buildConfig());
  const ws = new Workspace({
    "/ssh": new Mount(resource, { mode: MountMode.READ, fuse: true }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() /ssh ---");
    for (const r of await readdir(mp)) console.log(`  ${r}`);

    const probe = `${mp}/etc/hostname`;
    console.log(`\n--- readFile() /ssh/etc/hostname ---`);
    try {
      const data = await readFile(probe, "utf-8");
      console.log(`  ${data.trim().slice(0, 200)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  (skipped: ${msg})`);
    }

    console.log("\n" + "=".repeat(72));
    console.log(`>>> FUSE mounted at:  ${mp}`);
    console.log(`>>> SSH root:         ${mp}`);
    console.log("=".repeat(72));
    console.log("\n>>> Open in Finder:");
    console.log(`>>>   open ${mp}`);
    console.log(">>> Or in another terminal:");
    console.log(`>>>   ls ${mp}/`);
    console.log(`>>>   cat ${mp}/etc/hostname`);
    console.log(`>>>   tree ${mp}/etc | head`);
    console.log("\n>>> Press Enter to unmount and exit...");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();

    const records = ws.records;
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0);
    console.log(
      `\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`,
    );
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
