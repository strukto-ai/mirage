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
  Outcome,
  RAMResource,
  Scope,
  Workspace,
  parseSessionProfile,
} from "@struktoai/mirage-node";

// Two rules that ask: one about a path, one about a whole command.
const ROLE = parseSessionProfile(
  {
    commands: {
      allow: ["ls", "cat", "rm"],
      ask: [
        { reason: "secrets are reviewed", commands: { cat: ["/data/secret.txt"] } },
        { reason: "deletes are reviewed", commands: ["rm"] },
      ],
    },
  },
  "profile `agent`",
);

async function run(ws: Workspace, line: string): Promise<void> {
  await ws.fs.writeFile("/data/a.txt", "a\n");
  await ws.fs.writeFile("/data/secret.txt", "s\n");
  const res = await ws.execute(line, { sessionId: "agent" });
  const how = res.refusal === null ? "ran" : `refused (${res.refusal.kind})`;
  console.log(`${line}: ${how}, exit ${String(res.exitCode)}`);
}

async function main(): Promise<void> {
  // No `onAsk`: nobody answers inline, so an asked line is refused for
  // now and its question waits in the ledger under an id the agent is
  // told to quote.
  const ws = new Workspace(
    { "/data/": new RAMResource() },
    { mode: MountMode.WRITE, profiles: { agent: ROLE } },
  );
  ws.createSession("agent", { profile: "agent" });
  try {
    await run(ws, "cat /data/secret.txt");
    await run(ws, "rm /data/a.txt");
    // The host reads the queue, one record per question and oldest
    // first, and answers each by id. ONCE passes one retry of that line;
    // SESSION passes every line the rule covers from now on.
    for (const waiting of ws.decisions.pending("agent")) {
      const scope = waiting.command === "cat" ? Scope.ONCE : Scope.SESSION;
      const words = waiting.argv.join(" ");
      console.log(
        `host: ${waiting.id} asks ${waiting.command} ${words} (${waiting.reason}): allow ${scope}`,
      );
      await ws.decisions.answer(waiting.id, Outcome.ALLOW, scope);
    }
    // Each retry consumes its answer.
    await run(ws, "cat /data/secret.txt");
    await run(ws, "rm /data/a.txt");
    // The once grant is spent; the session grant still covers rm.
    await run(ws, "cat /data/secret.txt");
    await run(ws, "rm /data/a.txt");
  } finally {
    await ws.close();
  }
}

await main();
