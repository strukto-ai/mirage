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
  FileStat,
  FileType,
  fuseMount,
  Mount,
  MountBackend,
  MountMode,
  RAMResource,
  Workspace,
  type Action,
  type OpsContext,
  type OpsResultContext,
  type Policy,
} from "@struktoai/mirage-node";

// Size-unknown probe: a stat wrapper simulates API-backed resources (Linear,
// Slack, Trello, ...) whose byte size is unknown until the content is
// fetched. Over FUSE such files must stat as 0 until first open and read
// fully afterwards (see the CLAUDE.md FUSE section).
const API_CONTENT = '{"messages": 2}\n';

async function runSizelessProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder();
  const api = new RAMResource();
  api.store.dirs.add("/");
  api.store.files.set("/api.json", enc.encode(API_CONTENT));
  const ws = new Workspace({
    "/api": new Mount(api, { mode: MountMode.READ }),
  });
  const realStat = ws.fs.stat.bind(ws.fs);
  ws.fs.stat = async (path) => {
    const s = await realStat(path);
    if (s.type === FileType.DIRECTORY) return s;
    return new FileStat({ name: s.name, type: s.type, size: null });
  };
  const handle = await fuseMount(ws);
  const apiFile = join(handle.mountpoint, "api", "api.json");
  try {
    // Windows cannot query attributes without opening a handle, so
    // hydrate-on-open runs and even the pre-open stat sees the real size.
    const pre = (await stat(apiFile)).size;
    const expectedPre = process.platform === "win32" ? API_CONTENT.length : 0;
    result.api_stat_preopen_ok = pre === expectedPre;
    result.api_cat = (await readFile(apiFile, "utf8")).trim();
    result.api_size_postread = (await stat(apiFile)).size;
  } finally {
    await handle.unmount();
  }
}

// Policy probe: FUSE serves the workspace's op door, so a preOps deny
// (sealed path) and a postOps deny (redacted content) must both surface as
// EACCES to ordinary file APIs, while unguarded reads pass.
class SealReadsPolicy implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (!ctx.write && ctx.path.virtual.endsWith(".sealed")) {
      return { kind: "deny", message: "sealed\n" };
    }
    return null;
  }
}

class RedactReadsPolicy implements Policy {
  postOps(ctx: OpsResultContext): Action | null {
    const data = ctx.result instanceof Uint8Array ? new TextDecoder().decode(ctx.result) : null;
    if (ctx.op === "read" && data !== null && data.includes("TOPSECRET")) {
      return { kind: "deny", message: "redacted\n" };
    }
    return null;
  }
}

async function runPolicyProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder();
  const res = new RAMResource();
  res.store.dirs.add("/");
  res.store.files.set("/clean.txt", enc.encode("hello\n"));
  res.store.files.set("/secret.txt", enc.encode("TOPSECRET plans\n"));
  res.store.files.set("/x.sealed", enc.encode("nope\n"));
  const ws = new Workspace(
    { "/guarded": new Mount(res, { mode: MountMode.READ, backend: MountBackend.FUSE }) },
    { policies: [new SealReadsPolicy(), new RedactReadsPolicy()] },
  );
  try {
    await ws.fuseReady();
    const mp = ws.fuseMountpoints["/guarded"];
    result.policy_clean_read = (await readFile(`${mp}/clean.txt`, "utf8")).trim();
    try {
      await readFile(`${mp}/x.sealed`);
      result.policy_sealed_eacces = false;
    } catch (err) {
      result.policy_sealed_eacces = (err as { code?: string }).code === "EACCES";
    }
    try {
      await readFile(`${mp}/secret.txt`);
      result.policy_redact_eacces = false;
    } catch (err) {
      result.policy_redact_eacces = (err as { code?: string }).code === "EACCES";
    }
  } finally {
    await ws.close();
  }
}

// Per-mount FUSE: two mounts exposed at distinct OS paths simultaneously. Reads
// go through the real kernel -> FUSE handler. Async fs APIs are required: the
// mounts' napi callbacks run on the single Node event loop, so a *sync* read
// would block the loop that has to service the callback and deadlock.
async function main(): Promise<void> {
  const result: Record<string, string | number | boolean | null> = {};
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
    "/data": new Mount(data, {
      mode: MountMode.WRITE,
      backend: MountBackend.FUSE,
      mountpoint: pinned,
    }),
    "/logs": new Mount(logs, { backend: MountBackend.FUSE }),
  });
  try {
    await ws.fuseReady();
    const dataMp = ws.fuseMountpoints["/data"];
    const logsMp = ws.fuseMountpoints["/logs"];

    result.data_cat_a = (await readFile(`${dataMp}/a.txt`, "utf8")).trim();
    result.logs_cat_b = (await readFile(`${logsMp}/b.txt`, "utf8")).trim();
    result.logs_size_b = (await stat(`${logsMp}/b.txt`)).size;
    result.data_pinned = dataMp === pinned;
    result.distinct_mounts = dataMp !== logsMp;

    const [, , dataMode] = await ws.resolve("/data");
    const [, , logsMode] = await ws.resolve("/logs");
    result.data_mode_is_write = dataMode === MountMode.WRITE;
    result.logs_mode_is_read = logsMode === MountMode.READ;

    let singular = false;
    try {
      void ws.fuseMountpoint;
    } catch {
      singular = true;
    }
    result.singular_raises_multi = singular;

    let collision = false;
    try {
      await ws.addFuseMount("/collide", pinned);
    } catch {
      collision = true;
    }
    result.collision_rejected = collision;
  } finally {
    await ws.close();
  }
  await runSizelessProbe(result);
  await runPolicyProbe(result);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
