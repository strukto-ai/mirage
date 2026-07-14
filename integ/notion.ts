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

import { createServer, type Server } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NotionResource as BrowserNotionResource } from "@struktoai/mirage-browser";
import { MemoryOAuthClientProvider } from "@struktoai/mirage-core";
import { MountMode, NotionResource, Workspace } from "@struktoai/mirage-node";
import { runNotFound, runProvisionProbe, runSedReadonlyProbe } from "./cases.ts";

const MOUNT = "/notion";
const PAGE_A = "aaaa1111-2222-3333-4444-555566667777";
const PAGE_B = "bbbb2222-3333-4444-5555-666677778888";
const PAGE_C = "cccc1111-2222-3333-4444-555566667777";
const BLOCK_NESTED = "dddd2222-3333-4444-5555-666677778888";
const DB_TASKS = "eeee1111-2222-3333-4444-555566667777";
const ROW_1 = "ffff1111-2222-3333-4444-555566667777";
const ROW_2 = "ffff2222-3333-4444-5555-666677778888";
const DIR_A = `${MOUNT}/pages/Project_Roadmap__${PAGE_A}`;
const DIR_B = `${MOUNT}/pages/Notes__${PAGE_B}`;
const DIR_C = `${DIR_A}/Q1_Goals__${PAGE_C}`;
const DB_DIR = `${MOUNT}/databases/Tasks__${DB_TASKS}`;
const ROW_1_DIR = `${DB_DIR}/Write_spec__${ROW_1}`;

const DEC = new TextDecoder();

type Json = Record<string, unknown>;

function user(uid: string): Json {
  return { object: "user", id: uid };
}

function titleProp(title: string): Json {
  return {
    title: {
      id: "title",
      type: "title",
      title: [{ type: "text", plain_text: title, text: { content: title } }],
    },
  };
}

function page(pageId: string, title: string, parent: Json): Json {
  return {
    object: "page",
    id: pageId,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    created_by: user("user-1"),
    last_edited_by: user("user-2"),
    parent,
    archived: false,
    url: `https://notion.example/${pageId.replaceAll("-", "")}`,
    properties: titleProp(title),
  };
}

function database(databaseId: string, title: string): Json {
  return {
    object: "database",
    id: databaseId,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    parent: { type: "workspace", workspace: true },
    archived: false,
    is_inline: false,
    url: `https://notion.example/${databaseId.replaceAll("-", "")}`,
    title: [{ type: "text", plain_text: title, text: { content: title } }],
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Priority: {
        id: "pri",
        name: "Priority",
        type: "number",
        number: { format: "number" },
      },
    },
  };
}

function text(content: string, annotations: Json = {}): Json {
  return { type: "text", plain_text: content, annotations, text: { content } };
}

function block(
  blockId: string,
  btype: string,
  payload: Json,
  hasChildren = false,
): Json {
  return {
    object: "block",
    id: blockId,
    type: btype,
    has_children: hasChildren,
    [btype]: payload,
  };
}

const PAGES: Record<string, Json> = {
  [PAGE_A]: page(PAGE_A, "Project Roadmap", {
    type: "workspace",
    workspace: true,
  }),
  [PAGE_B]: page(PAGE_B, "Notes", { type: "workspace", workspace: true }),
  [PAGE_C]: page(PAGE_C, "Q1 Goals", { type: "page_id", page_id: PAGE_A }),
};

const BLOCKS: Record<string, Json[]> = {
  [PAGE_A]: [
    block("b-a1", "heading_1", { rich_text: [text("Roadmap")] }),
    block("b-a2", "paragraph", {
      rich_text: [
        text("Ship the "),
        text("beta", { bold: true }),
        text(" soon"),
      ],
    }),
    block(
      BLOCK_NESTED,
      "bulleted_list_item",
      { rich_text: [text("phase one")] },
      true,
    ),
    block("b-a4", "code", {
      rich_text: [text("print(1)")],
      language: "python",
    }),
    block(PAGE_C, "child_page", { title: "Q1 Goals" }, true),
  ],
  [PAGE_B]: [
    block("b-b1", "paragraph", { rich_text: [text("alpha beta gamma")] }),
    block("b-b2", "to_do", { rich_text: [text("done item")], checked: true }),
  ],
  [PAGE_C]: [block("b-c1", "paragraph", { rich_text: [text("Q1 contents")] })],
  [BLOCK_NESTED]: [
    block("b-d1", "bulleted_list_item", {
      rich_text: [text("phase one detail")],
    }),
  ],
};

const DATABASES: Record<string, Json> = {
  [DB_TASKS]: database(DB_TASKS, "Tasks"),
};

const DB_ROWS: Record<string, Json[]> = {
  [DB_TASKS]: [
    page(ROW_1, "Write spec", { type: "database_id", database_id: DB_TASKS }),
    page(ROW_2, "Ship beta", { type: "database_id", database_id: DB_TASKS }),
  ],
};

const ROW_PAGES: Record<string, Json> = Object.fromEntries(
  Object.values(DB_ROWS).flatMap((rows) =>
    rows.map((row) => [String(row.id), row]),
  ),
);

function searchResults(args: Json): Json[] {
  const filter = (args.filter ?? {}) as Json;
  return filter.value === "database"
    ? Object.values(DATABASES)
    : Object.values(PAGES);
}

function startMockServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const parts = path.split("/").filter((part) => part !== "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw === "" ? {} : (JSON.parse(raw) as Json);
      const sendJson = (payload: unknown): void => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (
        req.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "v1" &&
        parts[1] === "pages"
      ) {
        const found = PAGES[parts[2] ?? ""] ?? ROW_PAGES[parts[2] ?? ""];
        if (found !== undefined) {
          sendJson(found);
          return;
        }
      }
      if (
        req.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "v1" &&
        parts[1] === "databases"
      ) {
        const found = DATABASES[parts[2] ?? ""];
        if (found !== undefined) {
          sendJson(found);
          return;
        }
      }
      if (
        req.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "v1" &&
        parts[1] === "blocks" &&
        parts[3] === "children"
      ) {
        sendJson({
          object: "list",
          results: BLOCKS[parts[2] ?? ""] ?? [],
          has_more: false,
          next_cursor: null,
        });
        return;
      }
      if (
        req.method === "POST" &&
        parts.length === 2 &&
        parts[0] === "v1" &&
        parts[1] === "search"
      ) {
        sendJson({
          object: "list",
          results: searchResults(body),
          has_more: false,
          next_cursor: null,
        });
        return;
      }
      if (
        req.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "v1" &&
        parts[1] === "databases" &&
        parts[3] === "query"
      ) {
        sendJson({
          object: "list",
          results: DB_ROWS[parts[2] ?? ""] ?? [],
          has_more: false,
          next_cursor: null,
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

function toolPayload(name: string, args: Record<string, unknown>): unknown {
  if (name === "API-post-search") {
    return {
      object: "list",
      results: searchResults(args),
      has_more: false,
      next_cursor: null,
    };
  }
  if (name === "API-retrieve-a-page") {
    const found =
      PAGES[String(args.page_id)] ?? ROW_PAGES[String(args.page_id)];
    if (found === undefined)
      throw new Error(`mock notion: unknown page ${String(args.page_id)}`);
    return found;
  }
  if (name === "API-retrieve-a-database") {
    const found = DATABASES[String(args.database_id)];
    if (found === undefined)
      throw new Error(
        `mock notion: unknown database ${String(args.database_id)}`,
      );
    return found;
  }
  if (name === "API-post-database-query") {
    return {
      object: "list",
      results: DB_ROWS[String(args.database_id)] ?? [],
      has_more: false,
      next_cursor: null,
    };
  }
  if (name === "API-retrieve-block-children") {
    return {
      object: "list",
      results: BLOCKS[String(args.block_id)] ?? [],
      has_more: false,
      next_cursor: null,
    };
  }
  throw new Error(`mock notion: unsupported tool ${name}`);
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "mock-notion-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: [] }),
  );
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const payload = toolPayload(req.params.name, req.params.arguments ?? {});
    return Promise.resolve({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });
  });
  return server;
}

function startMockMcpServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    void (async () => {
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls_root", `ls ${MOUNT}/`],
  ["ls_pages", `ls ${MOUNT}/pages/`],
  ["ls_l_pages", `ls -l ${MOUNT}/pages/`],
  ["ls_page_a", `ls ${DIR_A}/`],
  ["stat_dir_a", `stat -c '%n %y' ${DIR_A}`],
  ["tree", `tree -L 2 ${MOUNT}/`],
  ["cat_page_a", `cat ${DIR_A}/page.json`],
  ["cat_child", `cat ${DIR_C}/page.json`],
  ["jq_title", `jq ".title" ${DIR_A}/page.json`],
  ["jq_markdown", `jq ".markdown" ${DIR_B}/page.json`],
  ["head_4", `head -n 4 ${DIR_A}/page.json`],
  ["wc_l_two", `wc -l ${DIR_A}/page.json ${DIR_B}/page.json`],
  ["stat_page_json", `stat ${DIR_A}/page.json`],
  ["find_json", `find ${MOUNT}/pages/ -name page.json`],
  ["find_root_maxdepth0", `find ${MOUNT} -maxdepth 0`],
  ["find_root_name", `find ${MOUNT} -name notion`],
  ["pipe_grep", `cat ${DIR_B}/page.json | grep -c alpha`],
  ["grep_file", `grep -n alpha ${DIR_B}/page.json`],
  ["grep_multi", `grep -c alpha ${DIR_A}/page.json ${DIR_B}/page.json`],
  ["grep_recursive", `grep -rl alpha ${MOUNT}/pages/`],
  ["realpath_dotdot", `realpath -e ${DIR_C}/../page.json`],
  ["ls_databases", `ls ${MOUNT}/databases/`],
  ["ls_database_dir", `ls ${DB_DIR}/`],
  ["cat_database_json", `cat ${DB_DIR}/database.json`],
  ["jq_db_props", `jq ".properties | keys" ${DB_DIR}/database.json`],
  ["cat_row", `cat ${ROW_1_DIR}/page.json`],
  ["du_pages", `du ${MOUNT}/pages/`],
  ["du_page_a", `du ${DIR_A}/`],
];

const EXIT_CODE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["grep_c_match_exit", `grep -c alpha ${DIR_B}/page.json`],
  ["grep_c_no_match_exit", `grep -c zzz ${DIR_B}/page.json`],
  ["grep_rc_no_match_exit", `grep -rc zzz ${MOUNT}/pages/`],
];

async function runCase(
  ws: Workspace,
  name: string,
  cmd: string,
): Promise<string> {
  const result = await ws.execute(cmd);
  const out = DEC.decode(result.stdout);
  return `=== ${name} ===\n` + (out.endsWith("\n") ? out : out + "\n");
}

async function runExitCase(
  ws: Workspace,
  name: string,
  cmd: string,
): Promise<string> {
  const result = await ws.execute(cmd);
  const out = DEC.decode(result.stdout);
  let rendered = `=== ${name} ===\nexit=${String(result.exitCode)}\n`;
  if (out !== "") rendered += out.endsWith("\n") ? out : out + "\n";
  return rendered;
}

async function main(): Promise<void> {
  const { server, port } = await startMockServer();
  const { server: mcpServer, port: mcpPort } = await startMockMcpServer();
  const restResource = new NotionResource({
    apiKey: "integ-test",
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
  });
  const restWs = new Workspace(
    { [MOUNT]: restResource },
    { mode: MountMode.READ },
  );
  const authProvider = new MemoryOAuthClientProvider({
    clientMetadata: { redirect_uris: ["http://127.0.0.1/cb"] },
    redirect: () => {},
  });
  const mcpResource = new BrowserNotionResource({
    authProvider,
    serverUrl: `http://127.0.0.1:${String(mcpPort)}/mcp`,
  });
  const mcpWs = new Workspace(
    { [MOUNT]: mcpResource },
    { mode: MountMode.READ },
  );
  try {
    const allCases: ReadonlyArray<
      readonly [
        string,
        string,
        (ws: Workspace, name: string, cmd: string) => Promise<string>,
      ]
    > = [
      ...CASES.map(([name, cmd]) => [name, cmd, runCase] as const),
      ...EXIT_CODE_CASES.map(
        ([name, cmd]) => [name, cmd, runExitCase] as const,
      ),
    ];
    let mismatches = 0;
    for (const [name, cmd, run] of allCases) {
      const restOut = await run(restWs, name, cmd);
      process.stdout.write(restOut);
      const mcpOut = await run(mcpWs, name, cmd);
      if (mcpOut !== restOut) {
        mismatches += 1;
        process.stderr.write(
          `MCP/REST MISMATCH in ${name}:\n--- rest ---\n${restOut}--- mcp ---\n${mcpOut}`,
        );
      }
    }
    if (mismatches > 0) {
      process.exitCode = 1;
    } else {
      const n = String(allCases.length);
      process.stderr.write(`mcp parity: ${n}/${n} cases byte-identical\n`);
    }
    await runNotFound(restWs, MOUNT);
    await runProvisionProbe(restWs, `${DIR_A}/page.json`);
    await runSedReadonlyProbe(restWs, `${DIR_A}/page.json`);
  } finally {
    await restWs.close();
    await mcpWs.close();
    server.close();
    mcpServer.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
