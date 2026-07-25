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
  DatabricksVolumeResource,
  DiscordResource,
  EmailResource,
  GDocsResource,
  GDriveResource,
  GitHubCIResource,
  GmailResource,
  GSheetsResource,
  GSlidesResource,
  LangfuseResource,
  LinearResource,
  Mem0Resource,
  MountMode,
  OneDriveResource,
  type Resource,
  SharePointResource,
  SlackResource,
  TrelloResource,
  Workspace,
} from "@struktoai/mirage-node";

function resources(): Array<readonly [string, string, Resource]> {
  return [
    [
      "databricks",
      "/databricks",
      new DatabricksVolumeResource({ catalog: "c", schema: "s", volume: "v", rootPath: "/" }),
    ],
    ["discord", "/discord", new DiscordResource({ token: "x" })],
    [
      "email",
      "/email",
      new EmailResource({
        imapHost: "h",
        imapPort: 993,
        smtpHost: "h",
        smtpPort: 587,
        username: "u",
        password: "p",
        useSsl: true,
        maxMessages: 200,
      }),
    ],
    ["gdocs", "/gdocs", new GDocsResource({ clientId: "c", refreshToken: "r" })],
    ["gdrive", "/gdrive", new GDriveResource({ clientId: "c", refreshToken: "r" })],
    ["github_ci", "/github_ci", new GitHubCIResource({ token: "t", owner: "o", repo: "r" })],
    ["gmail", "/gmail", new GmailResource({ clientId: "c", refreshToken: "r" })],
    ["gsheets", "/gsheets", new GSheetsResource({ clientId: "c", refreshToken: "r" })],
    ["gslides", "/gslides", new GSlidesResource({ clientId: "c", refreshToken: "r" })],
    ["langfuse", "/langfuse", new LangfuseResource({ publicKey: "p", secretKey: "s" })],
    ["linear", "/linear", new LinearResource({ apiKey: "k" })],
    ["mem0", "/mem0", new Mem0Resource({ apiKey: "k", userId: "u" })],
    ["onedrive", "/onedrive", new OneDriveResource({ accessToken: "t" })],
    ["sharepoint", "/sharepoint", new SharePointResource({ accessToken: "t" })],
    ["slack", "/slack", new SlackResource({ token: "x" })],
    ["trello", "/trello", new TrelloResource({ apiKey: "k", apiToken: "t" })],
  ];
}

// Invalid -maxdepth/-mindepth/-size/-mtime must be rejected during flag
// parsing, before any network call, identically on every backend.
// Cross-checked py vs ts. (github needs a live repo at construct, notion needs
// an OAuth provider and hf_buckets validates the bucket id, so those are
// excluded from this cred-free cross-language suite.)
const ARG_ERROR_CASES: ReadonlyArray<readonly [string, string]> = [
  ["maxdepth", "-maxdepth abc"],
  ["mindepth", "-mindepth xx"],
  ["size", "-size abc"],
  ["mtime", "-mtime abc"],
];

async function main(): Promise<void> {
  const dec = new TextDecoder();
  for (const [name, mount, resource] of resources()) {
    const ws = new Workspace({ [mount]: resource }, { mode: MountMode.READ });
    for (const [label, expr] of ARG_ERROR_CASES) {
      const result = await ws.execute(`find ${mount} ${expr}`);
      const err = dec.decode(result.stderr).trim();
      process.stdout.write(`=== ${name}:${label} ===\n`);
      process.stdout.write(`exit=${result.exitCode}\n`);
      if (err) process.stdout.write(err + "\n");
    }
    await ws.close();
  }
}

void main();
