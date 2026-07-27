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

// TypeScript cannot serve an FSKit mount. '@zkochan/fuse-native' bundles a
// pre-macFUSE-5 dylib with no route to FSKit, so `backend: fskit` is
// rejected up front instead of failing halfway through a mount. This shows
// the refusal and the two things you can actually do about it.
//
//     pnpm --dir examples/typescript exec tsx fuse/fskit.ts

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Mount,
  MountBackend,
  MountMode,
  RAMResource,
  Workspace,
} from "@struktoai/mirage-node";

const CONTENT = new TextEncoder().encode('{"messages": 2}\n');

function seed(): RAMResource {
  const resource = new RAMResource();
  resource.store.dirs.add("/");
  resource.store.files.set("/api.json", CONTENT);
  return resource;
}

async function main(): Promise<void> {
  console.log("=== backend: fskit ===");
  try {
    new Workspace({
      "/data": new Mount(seed(), {
        mode: MountMode.WRITE,
        backend: MountBackend.FSKIT,
      }),
    });
    console.log("  mounted (unexpected)");
  } catch (err) {
    console.log(`  refused: ${(err as Error).message}`);
  }

  // Option 1: the same mount over the kernel extension, which the TS
  // binding does support. This is the one to use on macOS with the kext
  // approved, or anywhere on Linux.
  console.log("\n=== backend: fuse (works here) ===");
  const mountpoint = await mkdtemp(join(tmpdir(), "mirage-"));
  const ws = new Workspace({
    "/data": new Mount(seed(), {
      mode: MountMode.WRITE,
      backend: MountBackend.FUSE,
      mountpoint,
    }),
  });
  try {
    const mp = ws.fuseMountpoints["/data"];
    console.log(`  mounted at ${mp}`);
    // Read from a child process, never synchronously from this one: a TS
    // FUSE mount is served by this event loop and would deadlock.
    const body = await readFile(join(mp, "api.json"), "utf8");
    console.log(`  cat api.json -> ${body.trim()}`);
  } finally {
    await ws.close();
    await rm(mountpoint, { recursive: true, force: true });
  }

  // Option 2: for a kext-free mount, use the Python package, which routes
  // through macFUSE 5.x's FSKit shim. See examples/python/fuse/fskit.py.
  console.log("\n  For kext-free mounts use Python:");
  console.log("    ./python/.venv/bin/python examples/python/fuse/fskit.py");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
