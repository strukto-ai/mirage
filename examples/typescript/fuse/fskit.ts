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

// Mount over Apple's FSKit from Node, with no kernel extension loaded.
// Needs macOS 15.4+ and macFUSE 5.x with its FSKit module enabled:
//
//     pnpm --dir examples/typescript exec tsx fuse/fskit.ts
//
// It mounts, reads, then shows the two things that will bite you: the
// mount-time warning for size-unknown resources (their files read as
// empty over fskit), and the partial write surface. Every probe below
// runs in a child process: a TS FUSE mount is served by this process's
// event loop, so touching the mountpoint synchronously from here would
// deadlock it.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  checkSizes,
  Mount,
  MountBackend,
  MountMode,
  RAMResource,
  Workspace,
} from "@struktoai/mirage-node";

const run = promisify(execFile);
const CONTENT = new TextEncoder().encode('{"messages": 2}\n');

class SizeUnknownRAM extends RAMResource {
  // A resource that cannot size its files, like Slack or Gmail.
  override readonly sizesAlwaysKnown = false;
}

function seed(resource: RAMResource): RAMResource {
  resource.store.dirs.add("/");
  resource.store.files.set("/api.json", CONTENT);
  resource.store.files.set("/existing.txt", new TextEncoder().encode("old\n"));
  return resource;
}

async function attempt(cmd: string, args: string[]): Promise<string> {
  try {
    await run(cmd, args);
    return "ok";
  } catch (err) {
    const failure = err as { code?: string | number; stderr?: string };
    const detail = (failure.stderr ?? "").trim().split("\n")[0];
    return detail === "" ? `failed (${String(failure.code)})` : detail;
  }
}

async function main(): Promise<void> {
  console.log("=== the size warning ===");
  // Demonstrated through checkSizes directly (the same guard every fskit
  // mount path runs) rather than a second kernel mount, because macOS
  // allows one FUSE mount per process and the working mount below needs it.
  const guarded = new Workspace({
    "/api": new Mount(seed(new SizeUnknownRAM()), { mode: MountMode.READ }),
  });
  try {
    checkSizes(MountBackend.FSKIT, guarded, "");
    console.log("  FSKit has no direct_io: a read is clamped to the size");
    console.log("  stat reported at lookup, and that clamp is never");
    console.log("  refreshed. A size-unknown file mounts anyway, stats as");
    console.log("  0, and reads as empty; the warning above names the");
    console.log("  mounts affected. Size push-down (#83) closes this.");
  } finally {
    await guarded.close();
  }

  console.log("\n=== fskit mount ===");
  const ws = new Workspace({
    "/data": new Mount(seed(new RAMResource()), {
      mode: MountMode.WRITE,
      backend: MountBackend.FSKIT,
    }),
  });
  try {
    await ws.fuseReady();
    const mp = ws.fuseMountpoints["/data"];
    console.log(`  mounted at ${mp}`);

    const rows = await run("mount", []);
    for (const line of rows.stdout.split("\n")) {
      if (line.includes(basename(mp))) console.log(`  ${line}`);
    }

    console.log("\n=== reads (from child processes) ===");
    const cat = await run("/bin/cat", [`${mp}/api.json`]);
    console.log(`  cat api.json -> ${cat.stdout.trim()}`);
    const wc = await run("/usr/bin/wc", ["-c", `${mp}/api.json`]);
    console.log(`  wc -c        -> ${wc.stdout.trim()}`);

    console.log("\n=== writes: only part of the surface works ===");
    console.log(
      "  append existing -> " +
        (await attempt("/bin/sh", ["-c", `echo x >> ${mp}/existing.txt`])),
    );
    console.log(
      "  unlink existing -> " + (await attempt("/bin/rm", [`${mp}/existing.txt`])),
    );
    console.log(
      "  create new file -> " + (await attempt("/usr/bin/touch", [`${mp}/new.txt`])),
    );
    console.log("  mkdir           -> " + (await attempt("/bin/mkdir", [`${mp}/sub`])));
    console.log(
      "  rename          -> " +
        (await attempt("/bin/mv", [`${mp}/api.json`, `${mp}/moved.json`])),
    );
    console.log("\n  Creating new names fails with ENOSYS from TypeScript:");
    console.log("  the FSKit shim finalizes new items via macFUSE's Darwin-only");
    console.log("  setattr_x/renamex callbacks, which fuse-native's compiled op");
    console.log("  table cannot gain from JS. Python declares them at runtime");
    console.log("  (mirage/fuse/darwin.py) and has the metadata surface; but on");
    console.log("  both languages the shim flushes pages a file did not already");
    console.log("  have (new file, truncate-then-write) as NUL bytes, so only");
    console.log("  appends to existing bytes persist real data (macFUSE FSKit");
    console.log("  bug, pinned in integ/fuse/truth_fskit.json). Prefer backend");
    console.log("  'fuse' for write-heavy mounts. See docs/typescript/setup/fuse.mdx.");
  } finally {
    await ws.close();
  }
  console.log("\nunmounted, done");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
