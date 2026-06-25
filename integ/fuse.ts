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

import { rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Mount,
  MountMode,
  RAMResource,
  Workspace,
} from "@struktoai/mirage-node";

// Per-mount FUSE: two mounts exposed at distinct OS paths simultaneously. Reads
// go through the real kernel -> FUSE handler. Async fs APIs are required: the
// mounts' napi callbacks run on the single Node event loop, so a *sync* read
// would block the loop that has to service the callback and deadlock.
async function main(): Promise<void> {
  const enc = new TextEncoder();
  const data = new RAMResource();
  data.store.dirs.add("/");
  data.store.files.set("/a.txt", enc.encode("alpha\n"));
  const logs = new RAMResource();
  logs.store.dirs.add("/");
  logs.store.files.set("/b.txt", enc.encode("beta\n"));

  // Non-existent pinned path: the mount must create it (mirrors the CLI flow).
  const pinned = join(tmpdir(), `mirage-fuse-data-${String(process.pid)}`);
  rmSync(pinned, { recursive: true, force: true });
  // Mount through the public per-mount Mount spec (what examples/users write):
  // /data pins its mountpoint and overrides the workspace default to WRITE;
  // /logs gets a generated mountpoint and inherits the default READ.
  const ws = new Workspace({
    "/data": new Mount(data, { mode: MountMode.WRITE, fuse: pinned }),
    "/logs": new Mount(logs, { fuse: true }),
  });
  try {
    await ws.fuseReady();
    const dataMp = ws.fuseMountpoints["/data"];
    const logsMp = ws.fuseMountpoints["/logs"];

    process.stdout.write(
      `data_cat_a=${(await readFile(`${dataMp}/a.txt`, "utf8")).trim()}\n`,
    );
    process.stdout.write(
      `logs_cat_b=${(await readFile(`${logsMp}/b.txt`, "utf8")).trim()}\n`,
    );
    process.stdout.write(
      `logs_size_b=${(await stat(`${logsMp}/b.txt`)).size}\n`,
    );
    process.stdout.write(`data_pinned=${dataMp === pinned ? "yes" : "no"}\n`);
    process.stdout.write(
      `distinct_mounts=${dataMp !== logsMp ? "yes" : "no"}\n`,
    );

    const [, , dataMode] = await ws.resolve("/data");
    const [, , logsMode] = await ws.resolve("/logs");
    process.stdout.write(
      `data_mode_is_write=${dataMode === MountMode.WRITE ? "yes" : "no"}\n`,
    );
    process.stdout.write(
      `logs_mode_is_read=${logsMode === MountMode.READ ? "yes" : "no"}\n`,
    );

    let singular = "no";
    try {
      void ws.fuseMountpoint;
    } catch {
      singular = "yes";
    }
    process.stdout.write(`singular_raises_multi=${singular}\n`);

    let collision = "no";
    try {
      await ws.addFuseMount("/collide", pinned);
    } catch {
      collision = "yes";
    }
    process.stdout.write(`collision_rejected=${collision}\n`);
  } finally {
    await ws.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
