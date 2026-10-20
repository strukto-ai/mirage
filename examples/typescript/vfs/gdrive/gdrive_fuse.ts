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

import { open, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  GoogleDriveVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  type GDriveConfig,
} from "@struktoai/mirage-node";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({
  path: resolve(__HERE, "../../../../.env.development"),
  override: true,
});

function buildConfig(): GDriveConfig {
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

const isFile = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

async function main(): Promise<void> {
  const vfs = new GoogleDriveVFS(buildConfig());
  const ws = new Workspace({
    "/gdrive": new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() root ---");
    const entries = await readdir(mp);
    for (const e of entries.slice(0, 10)) console.log(`  ${e}`);

    for (const e of entries) {
      const path = `${mp}/${e}`;
      if (!(await isFile(path))) continue;
      console.log(`\n--- reading ${e} ---`);
      const fh = await open(path, "r");
      try {
        const { bytesRead } = await fh.read(Buffer.alloc(1024), 0, 1024, 0);
        console.log(`  ${String(bytesRead)} bytes (first 1024)`);
      } finally {
        await fh.close();
      }
      break;
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/`);
    console.log(">>> Press Enter to unmount and exit...");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();

    const records = ws.records;
    const total = records.reduce((s, r) => s + (r.bytes ?? 0), 0);
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`);
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
