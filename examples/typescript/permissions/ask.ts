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
import type { AskHandler, Decision } from "@struktoai/mirage-node";

// One profile, one rule. `allow` is what the session may run at all;
// `ask` puts one of those commands to a person before it runs.
const ROLE = parseSessionProfile(
  {
    commands: {
      allow: ["ls", "rm", "printf", "xargs", "sleep", "wait", "eval", "shopt", "alias"],
      ask: [{ reason: "deletes are reviewed", commands: ["rm"] }],
    },
  },
  "profile `agent`",
);

/**
 * The host answering inline: the ledger awaits this while the line
 * waits, the way a tool-approval prompt works. ALLOW at ONCE passes this
 * line only; SESSION would pass every rm for the rest of the session.
 */
const reviewer: AskHandler = (record: Decision): Promise<Decision> => {
  console.log(`approve? ${record.command} ${record.argv.join(" ")}`);
  return Promise.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE });
};

async function run(ws: Workspace, line: string): Promise<void> {
  await ws.fs.writeFile("/data/a.txt", "a\n");
  const res = await ws.execute(line, { sessionId: "agent" });
  const how = res.refusal === null ? "ran" : `refused (${res.refusal.kind})`;
  console.log(`${line}: ${how}, exit ${String(res.exitCode)}`);
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { "/data/": new RAMResource() },
    { mode: MountMode.WRITE, profiles: { agent: ROLE }, onAsk: reviewer },
  );
  ws.createSession("agent", { profile: "agent" });
  try {
    await run(ws, "rm /data/a.txt");
    // Once means once: the same line asks again.
    await run(ws, "rm /data/a.txt");
    // One place on the line is one question, however often the run
    // visits it: the loop body asks once and both iterations run on the
    // answer.
    await run(ws, "for i in 1 2; do rm -f /data/a.txt; done");
    // A question is about the words that run: xargs appends its input
    // to rm, so the question names the operand, not a bare rm.
    await run(ws, "printf /data/a.txt | xargs rm");
    // A job outlives the line that launched it, and a line the job hands
    // on later (here through eval) runs on the grant the job took with
    // it: the one question was asked before the launch, and nothing asks
    // again when the job gets to it.
    await run(ws, "sleep 0.2 && eval 'rm -f /data/a.txt' &");
    await run(ws, "wait");
    // An alias is read as a fresh line under the word that named it, so
    // each invocation is a place of its own: `d && d` is two questions,
    // as `rm -f /data/a.txt && rm -f /data/a.txt` is.
    await run(ws, "shopt -s expand_aliases; alias d='rm -f /data/a.txt'");
    await run(ws, "d && d");
  } finally {
    await ws.close();
  }
}

await main();
