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
  MountMode,
  RAMVFS,
  Workspace,
  parseSessionProfile,
} from "@struktoai/mirage-node";
import type {
  Ops,
  SessionExecuteOptions,
  Session,
} from "@struktoai/mirage-node";

// One agent, one session. `ws.session(id, { profile })` creates a session
// under a role and hands back its two doors bound together: `shell`
// runs a shell line as the session and `vfs` is the op facade run as it.
// Whichever door an agent's tools use, the same profile answers.
//
// Two roles read one world and see two filesystems. The reviewer's
// profile hides /repo/secrets and its session caps /repo at read, so the
// directory does not exist for it on either door and a write is a
// read-only file system on either door. The editor may write, and a
// deny rule keeps it out of the secrets by name, so the same file is
// "does not exist" for one role and "permission denied" for the other,
// through the shell and through vfs.read alike. The workspace names no
// default profile, so its own doors (`ws.vfs`, bare `ws.shell`) are
// the host's view. A second `ws.session(id)` adopts the session as is;
// naming a profile for a session that already exists is refused.

const PROFILES = {
  reviewer: { paths: { hide: ["/repo/secrets"] } },
  editor: {
    commands: {
      deny: [
        { reason: "keys are never read by hand", paths: ["/repo/secrets/*"] },
      ],
    },
  },
};

const SEED = [
  "mkdir -p /repo/secrets",
  "echo 'hello repo' > /repo/README.md",
  "echo 'PRIVATE' > /repo/secrets/key.pem",
];

const dec = new TextDecoder();

function shell(out: string, err: string, code: number): string {
  if (err !== "") return `[${code}] ${err.split("\n")[0]}`;
  return `[${code}] ${out.split(/\s+/).filter(Boolean).join(" ")}`.trimEnd();
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function show(
  role: string,
  door: string,
  call: string,
  answer: string,
  note: string,
): void {
  console.log(`${pad(role, 9)} ${pad(door, 9)} ${pad(call, 34)} ${answer}`);
  console.log(`${pad("", 9)} ${pad("", 9)} ${pad("", 34)} ${note}`);
}

function codeOf(err: unknown): string {
  return String((err as { code?: string }).code ?? err);
}

type PlainExecute = SessionExecuteOptions & { provision?: false };

interface Doors {
  shell(
    cmd: string,
    options?: PlainExecute,
  ): Promise<{
    stdout: Uint8Array | null;
    stderr: Uint8Array | null;
    exitCode: number;
  }>;
  vfs: Ops;
}

async function line(
  role: string,
  handle: Doors,
  cmd: string,
  note: string,
  options: PlainExecute = {},
): Promise<void> {
  const res = await handle.shell(cmd, options);
  const out = res.stdout === null ? "" : dec.decode(res.stdout);
  const err = res.stderr === null ? "" : dec.decode(res.stderr);
  show(role, "shell", cmd, shell(out, err, res.exitCode), note);
}

async function read(
  role: string,
  handle: Doors,
  path: string,
  note: string,
  sessionId?: string,
): Promise<void> {
  const call = sessionId === undefined ? path : `${path} as ${sessionId}`;
  try {
    show(
      role,
      "vfs.read",
      call,
      (await handle.vfs.readFileText(path, "utf-8", sessionId)).trim(),
      note,
    );
  } catch (err) {
    show(role, "vfs.read", call, codeOf(err), note);
  }
}

async function write(
  role: string,
  handle: Doors,
  path: string,
  note: string,
): Promise<void> {
  try {
    await handle.vfs.writeFile(path, `${role} wrote\n`);
    show(role, "vfs.write", path, "ok", note);
  } catch (err) {
    show(role, "vfs.write", path, codeOf(err), note);
  }
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { "/repo/": new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: Object.fromEntries(
        Object.entries(PROFILES).map(([name, doc]) => [
          name,
          parseSessionProfile(doc, `profile \`${name}\``),
        ]),
      ),
    },
  );
  for (const seed of SEED) await ws.shell(seed);

  const reviewer: Session = await ws.session("reviewer", {
    profile: "reviewer",
    mounts: { "/repo": "read" },
  });
  const editor = await ws.session("editor", { profile: "editor" });
  const host: Doors = {
    shell: (cmd, options) => ws.shell(cmd, options),
    vfs: ws.vfs,
  };

  await line(
    "reviewer",
    reviewer,
    "cat /repo/README.md",
    "the shell door, as the reviewer",
  );
  await line(
    "reviewer",
    reviewer,
    "cat /repo/secrets/key.pem",
    "the reviewer's profile hides the directory",
  );
  await line(
    "editor",
    editor,
    "cat /repo/secrets/key.pem",
    "the editor's rule denies the file by name",
  );
  await read(
    "reviewer",
    reviewer,
    "/repo/secrets/key.pem",
    "the op door, the same hide, the same answer",
  );
  await read(
    "editor",
    editor,
    "/repo/secrets/key.pem",
    "the op door, the same rule, the same answer",
  );
  await read(
    "host",
    host,
    "/repo/secrets/key.pem",
    "no default profile: the workspace's own door sees it",
  );
  await read(
    "host",
    host,
    "/repo/secrets/key.pem",
    "the same door, named per call: the reviewer's hide",
    "reviewer",
  );
  await read(
    "host",
    host,
    "/repo/secrets/key.pem",
    "and the editor's own rule, from the same call site",
    "editor",
  );

  await write(
    "reviewer",
    reviewer,
    "/repo/new.txt",
    "the reviewer's handle caps /repo at read",
  );
  await write("editor", editor, "/repo/new.txt", "the editor may write");
  await read(
    "reviewer",
    reviewer,
    "/repo/new.txt",
    "one world: the reviewer reads what the editor wrote",
  );
  await line(
    "reviewer",
    reviewer,
    "echo x > /repo/new.txt",
    "the shell door reads the same cap",
  );
  await line("editor", editor, "echo x > /repo/new.txt", "and the same grant");

  const again = await ws.session("reviewer");
  show(
    "reviewer",
    "session",
    "ws.session('reviewer')",
    again.sessionId,
    "an existing session is adopted as is",
  );
  try {
    await ws.session("reviewer", { profile: "editor" });
  } catch (err) {
    show(
      "reviewer",
      "session",
      "ws.session('reviewer', profile=...)",
      `refused: ${(err as Error).message}`,
      "a profile is set once, at creation",
    );
  }
  await ws.close();
}

await main();
