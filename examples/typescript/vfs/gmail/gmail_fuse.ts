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

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  GmailVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  type GmailConfig,
} from "@struktoai/mirage-node";
import dotenv from "dotenv";

const __HERE = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({
  path: resolve(__HERE, "../../../../.env.development"),
  override: true,
});

function buildConfig(): GmailConfig {
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

const isDir = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isDirectory(),
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      return false;
    },
  );

async function main(): Promise<void> {
  const vfs = new GmailVFS(buildConfig());
  const ws = new Workspace({
    "/gmail": new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  });
  await ws.fuseReady();
  const mp = ws.fuseMountpoint as string;
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`);

    console.log("--- readdir() labels ---");
    const labels = await readdir(mp);
    for (const label of labels) console.log(`  ${label}`);

    const inboxPath = `${mp}/INBOX`;
    if (await isDir(inboxPath)) {
      console.log("\n--- readdir() INBOX (dates) ---");
      const dates = await readdir(inboxPath);
      for (const d of dates.slice(0, 5)) console.log(`  ${d}`);

      const firstDate = dates[0];
      if (firstDate !== undefined) {
        const datePath = `${inboxPath}/${firstDate}`;
        console.log(`\n--- readdir() ${firstDate} ---`);
        const messages = await readdir(datePath);
        for (const m of messages.slice(0, 5)) console.log(`  ${m}`);

        const first = messages.find((m) => m.endsWith(".gmail.json"));
        if (first !== undefined) {
          const path = `${datePath}/${first}`;

          // Size-unknown semantics: rendered .gmail.json length is not
          // knowable without rendering (Gmail's sizeEstimate is the
          // source message, not the render), so stat before open
          // reports 0; after a read the real size is served from the
          // hydrated handle.
          console.log("\n--- stat before open (expect size 0) ---");
          console.log(`  size: ${String((await stat(path)).size)}`);

          console.log(`--- readFile() ${first.slice(0, 60)} ---`);
          const content = await readFile(path, "utf8");
          const parsed = JSON.parse(content) as {
            subject?: string;
            from?: { name?: string; email?: string };
          };
          console.log(`  subject: ${parsed.subject ?? "N/A"}`);
          console.log(`  from: ${parsed.from !== undefined ? JSON.stringify(parsed.from) : "N/A"}`);
          console.log(`  rendered bytes: ${String(Buffer.byteLength(content))}`);

          console.log("--- stat after read (real rendered size) ---");
          console.log(`  size: ${String((await stat(path)).size)}`);
        }
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`);
    console.log(">>> Open another terminal and run:");
    console.log(`>>>   ls ${mp}/`);
    console.log(`>>>   ls ${mp}/INBOX/`);
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
