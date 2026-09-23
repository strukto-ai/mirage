# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
"""Regenerate the live Notion recordings the notion fake is replayed against.

Usage, from the repo root::

    ./python/.venv/bin/python scripts/gen_notion_atlas.py [--parquet PATH]

MCP-Atlas (ScaleAI, CC-BY-4.0) recorded every tool call its agents made
against a live Notion workspace through ``@notionhq/notion-mcp-server``
1.8.1, which speaks ``Notion-Version: 2022-06-28``. Each Notion call and
its reply is kept here, with the workspace the replies show: its six
databases, its users, and every row any reply carried. A row is stored as
bare cell values because the recordings are regular enough to rebuild the
live object from them exactly, and this script refuses to write anything
it could not rebuild byte for byte.

A reply is stored as its envelope and the ids of its results; the replay
(``integ/notion_atlas.ts``) rebuilds each result the same way and compares
the whole reply. The fake orders a query's rows by stored position, so
the rows are written in an order every recorded reply agrees with.
"""

import argparse
import json
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "integ" / "truth" / "notion_atlas.json"
REVISION = "8c563b55d7c967755f474299848049834d624617"
URL = ("https://huggingface.co/datasets/ScaleAI/MCP-Atlas/resolve/"
       f"{REVISION}/MCP-Atlas.parquet")
TOOL_PREFIX = "notion_"
URL_BASE = "https://www.notion.so/"
ANNOTATIONS = {
    "bold": False,
    "italic": False,
    "strikethrough": False,
    "underline": False,
    "code": False,
    "color": "default",
}

Json = dict[str, Any]


def fail(message: str) -> None:
    sys.exit(f"gen_notion_atlas: {message}")


def load_calls(parquet: Path) -> list[Json]:
    """Every Notion tool call in dataset order, paired with its reply.

    Args:
        parquet (Path): the MCP-Atlas parquet file.

    Returns:
        list[Json]: ``{task, tool, args, reply}`` per call.
    """
    calls: list[Json] = []
    for row in pq.read_table(parquet).to_pylist():
        pending: dict[str, Json] = {}
        for message in json.loads(row["TRAJECTORY"]):
            for call in message.get("tool_calls") or []:
                pending[call["id"]] = call["function"]
            function = pending.get(message.get("tool_call_id", ""))
            if function is None or not function["name"].startswith(
                    TOOL_PREFIX):
                continue
            text = "".join(part["text"] for part in message["content"])
            calls.append({
                "task": row["TASK"],
                "tool": function["name"][len(TOOL_PREFIX):],
                "args": json.loads(function["arguments"]),
                "reply": json.loads(text),
            })
    return calls


def rich_text(content: str) -> list[Json]:
    return [{
        "type": "text",
        "text": {
            "content": content,
            "link": None
        },
        "annotations": dict(ANNOTATIONS),
        "plain_text": content,
        "href": None,
    }]


def cell_value(prop: Json) -> Any:
    """The bare value a recorded property holds.

    Args:
        prop (Json): a page property object.

    Returns:
        Any: text, number, bool, option name or start date.
    """
    kind = prop["type"]
    value = prop[kind]
    if kind in ("title", "rich_text"):
        return "".join(part["plain_text"] for part in value)
    if kind == "select":
        return value["name"]
    if kind == "date":
        return value["start"]
    return value


def build_prop(column: Json, value: Any) -> Json:
    """The live property object a bare value stands for.

    Args:
        column (Json): the schema column.
        value (Any): the bare value.

    Returns:
        Json: ``{id, type, <type>: value}`` as Notion renders it.
    """
    kind = column["type"]
    if kind in ("title", "rich_text"):
        rendered: Any = rich_text(value)
    elif kind == "select":
        option = next(o for o in column["select"]["options"]
                      if o["name"] == value)
        rendered = {k: option[k] for k in ("id", "name", "color")}
    elif kind == "date":
        rendered = {"start": value, "end": None, "time_zone": None}
    else:
        rendered = value
    return {"id": column["id"], "type": kind, kind: rendered}


def page_url(title: str, page_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "-", title).strip("-")
    return f"{URL_BASE}{slug + '-' if slug else ''}{page_id.replace('-', '')}"


def column_of(columns: Json, ref: str) -> str | None:
    """The column a filter, a sort or ``filter_properties`` names.

    Args:
        columns (Json): the schema, by column name.
        ref (str): a name or an id, the id encoded or not.

    Returns:
        str | None: the column name.
    """
    encoded = urllib.parse.quote(ref, safe="-_.!~*'()")
    for name, column in columns.items():
        if ref in (name, column["id"]) or encoded == column["id"]:
            return name
    return None


def picked(columns: Json, refs: list[str]) -> list[str]:
    """The columns ``filter_properties`` keeps, in the order it names them.

    Args:
        columns (Json): the schema, by column name.
        refs (list[str]): names or ids.

    Returns:
        list[str]: column names.
    """
    out: list[str] = []
    for ref in refs:
        name = column_of(columns, ref)
        if name is not None and name not in out:
            out.append(name)
    return out


def filter_refs(node: Json) -> list[str]:
    branches = node.get("and", node.get("or"))
    if branches is not None:
        return [ref for child in branches for ref in filter_refs(child)]
    return [node["property"]] if "property" in node else []


def read_columns(call: Json, columns: Json) -> set[str]:
    """Every column a query's filter and sorts read.

    Args:
        call (Json): a recorded query.
        columns (Json): the schema, by column name.

    Returns:
        set[str]: column names.
    """
    args = call["args"]
    refs = filter_refs(args.get("filter", {})) + [
        sort["property"]
        for sort in args.get("sorts", []) if "property" in sort
    ]
    return {name for name in (column_of(columns, ref) for ref in refs) if name}


def build_page(db: Json, rows: Json, page_id: str, refs: list[str]) -> Json:
    """The live page object a stored row stands for.

    Args:
        db (Json): the recorded database object.
        rows (Json): the stored rows block of that database.
        page_id (str): the row's id.
        refs (list[str]): the call's ``filter_properties``.

    Returns:
        Json: the page as the recording carries it.
    """
    cells = rows["cells"][page_id]
    columns = db["properties"]
    title = next((cells[name] for name, col in columns.items()
                  if col["type"] == "title" and name in cells), "")
    names = picked(columns, refs) if refs else list(columns)
    props = {
        name: build_prop(columns[name], cells[name])
        for name in names if name in cells
    }
    return {
        "object": "page",
        "id": page_id,
        "created_time": rows["created_time"],
        "last_edited_time": rows["last_edited_time"],
        "created_by": {
            "object": "user",
            "id": rows["author"]
        },
        "last_edited_by": {
            "object": "user",
            "id": rows["author"]
        },
        "cover": None,
        "icon": None,
        "parent": {
            "type": "database_id",
            "database_id": db["id"]
        },
        "archived": False,
        "in_trash": False,
        "properties": props,
        "url": rows["urls"].get(page_id, page_url(title, page_id)),
        "public_url": None,
    }


def gather(calls: list[Json]) -> tuple[Json, list[Json], Json]:
    """The workspace every reply agrees on.

    Args:
        calls (list[Json]): the recorded calls.

    Returns:
        tuple: databases by id (in first-search order), the users list,
        and the rows block per database.
    """
    databases: Json = {}
    users: list[Json] = []
    pages: Json = {}
    for call in calls:
        for item in call["reply"].get("results", []):
            if item["object"] == "database":
                if databases.setdefault(item["id"], item) != item:
                    fail(f"database {item['id']} differs between replies")
            elif item["object"] == "user":
                if item not in users:
                    users.append(item)
            else:
                pages.setdefault(item["id"], []).append(item)
    blocks: Json = {}
    for page_id, seen in pages.items():
        db_id = seen[0]["parent"]["database_id"]
        block = blocks.setdefault(
            db_id, {
                "created_time": seen[0]["created_time"],
                "last_edited_time": seen[0]["last_edited_time"],
                "author": seen[0]["created_by"]["id"],
                "cells": {},
                "urls": {},
            })
        cells: Json = {}
        for page in seen:
            for key, want in (("created_time", block["created_time"]),
                              ("last_edited_time",
                               block["last_edited_time"]), ("created_by", {
                                   "object":
                                   "user",
                                   "id":
                                   block["author"]
                               })):
                if page[key] != want:
                    fail(f"{page_id}: {key} is not its database's")
            for name, prop in page["properties"].items():
                value = cell_value(prop)
                if value in (None, "", []):
                    fail(f"{page_id}.{name} is empty; the encoding has no "
                         "room for an empty value")
                if cells.setdefault(name, value) != value:
                    fail(f"{page_id}.{name} differs between replies")
        block["cells"][page_id] = cells
        title = next((cells[n]
                      for n, c in databases[db_id]["properties"].items()
                      if c["type"] == "title" and n in cells), None)
        if title is None:
            block["urls"][page_id] = seen[0]["url"]
    return databases, users, blocks


def equalities(node: Json) -> list[Json]:
    """The single-key ``equals`` conditions every match of a filter meets.

    Args:
        node (Json): a filter tree.

    Returns:
        list[Json]: conditions under an ``and`` chain; an ``or`` says
        nothing about any one row.
    """
    if "and" in node:
        return [c for child in node["and"] for c in equalities(child)]
    if "or" in node or "property" not in node:
        return []
    kind = next((k for k in ("title", "rich_text", "select", "number",
                             "checkbox", "date") if k in node), None)
    if kind is None or list(node[kind]) != ["equals"]:
        return []
    return [{"property": node["property"], "value": node[kind]["equals"]}]


def infer_cells(calls: list[Json], databases: Json, blocks: Json) -> None:
    """Fill what a row's matching a filter proves about a column it hides.

    A reply with ``filter_properties`` carries only the columns it names,
    but the filter may test others: the fake cannot tell such a row
    matches unless it holds the tested value, and an ``equals`` the row
    passed is that value. Where the value is known it must agree, which
    checks the reading of the filter against live Notion.

    Args:
        calls (list[Json]): the recorded calls.
        databases (Json): databases by id.
        blocks (Json): the rows block per database, filled in place.
    """
    for call in calls:
        args = call["args"]
        if call["tool"] != "API-post-database-query" or "filter" not in args:
            continue
        columns = databases[args["database_id"]]["properties"]
        cells = blocks[args["database_id"]]["cells"]
        for cond in equalities(args["filter"]):
            name = column_of(columns, cond["property"])
            if name is None:
                fail(f"{call['task']}: filter names no column "
                     f"{cond['property']}")
            for item in call["reply"]["results"]:
                row = cells[item["id"]]
                if row.setdefault(name, cond["value"]) != cond["value"]:
                    fail(f"{call['task']}: {item['id']} matched {name} = "
                         f"{cond['value']!r} but holds {row[name]!r}")


def check_rebuild(calls: list[Json], databases: Json, blocks: Json) -> None:
    for call in calls:
        refs = call["args"].get("filter_properties", [])
        for item in call["reply"].get("results", []):
            if item["object"] != "page":
                continue
            db = databases[item["parent"]["database_id"]]
            rebuilt = build_page(db, blocks[db["id"]], item["id"], refs)
            if json.dumps(rebuilt) != json.dumps(item):
                fail(f"{call['task']}: cannot rebuild {item['id']} exactly")


def row_order(calls: list[Json], databases: Json,
              blocks: Json) -> dict[str, list[str]]:
    """Each database's rows in an order every recorded reply agrees with.

    A query with no sort returns rows in the database's own order, so each
    such reply is a chain in it; a first page of an unfiltered query also
    says nothing else comes before it. A sorted query breaks a tie in that
    same order (the rows of a tie are consecutive in it), so a tie is a
    chain too. Rows nothing orders go to the row recorded first.

    Args:
        calls (list[Json]): the recorded calls.
        databases (Json): databases by id.
        blocks (Json): the rows block per database.

    Returns:
        dict[str, list[str]]: row ids per database.
    """
    first_seen: dict[str, int] = {}
    for call in calls:
        for item in call["reply"].get("results", []):
            if item["object"] == "page":
                first_seen.setdefault(item["id"], len(first_seen))
    after: dict[str, set[str]] = defaultdict(set)
    for call in calls:
        results = call["reply"].get("results", [])
        ids = [item["id"] for item in results if item["object"] == "page"]
        args = call["args"]
        if call["tool"] != "API-post-database-query":
            continue
        if args.get("sorts"):
            tie_order(call, ids, databases, blocks, after)
            continue
        chain = ids + ([call["reply"]["next_cursor"]]
                       if call["reply"]["next_cursor"] in first_seen else [])
        for a, b in zip(chain, chain[1:]):
            after[a].add(b)
        if "filter" not in args and "start_cursor" not in args:
            rest = set(blocks[args["database_id"]]["cells"]) - set(chain)
            for page_id in rest:
                after[chain[-1]].add(page_id)
    order: dict[str, list[str]] = {}
    for db_id, block in blocks.items():
        nodes = set(block["cells"])
        before = {n: 0 for n in nodes}
        for a in nodes:
            for b in after[a] & nodes:
                before[b] += 1
        ready = sorted((n for n in nodes if before[n] == 0),
                       key=first_seen.__getitem__)
        out: list[str] = []
        while ready:
            node = ready.pop(0)
            out.append(node)
            for nxt in after[node] & nodes:
                before[nxt] -= 1
                if before[nxt] == 0:
                    ready.append(nxt)
            ready.sort(key=first_seen.__getitem__)
        if len(out) != len(nodes):
            fail(f"database {db_id}: the recorded row orders disagree")
        order[db_id] = out
    return order


def tie_order(call: Json, ids: list[str], databases: Json, blocks: Json,
              after: dict[str, set[str]]) -> None:
    args = call["args"]
    if len(args["sorts"]) != 1 or "property" not in args["sorts"][0]:
        return
    columns = databases[args["database_id"]]["properties"]
    cells = blocks[args["database_id"]]["cells"]
    name = column_of(columns, args["sorts"][0]["property"])
    keys = [cells[page_id].get(name) for page_id in ids]
    for a, b, ka, kb in zip(ids, ids[1:], keys, keys[1:]):
        if ka is not None and ka == kb:
            after[a].add(b)
    if ("filter" in args or "start_cursor" in args
            or not call["reply"]["has_more"] or not ids or keys[-1] is None):
        return
    for page_id, row in cells.items():
        if page_id not in ids and row.get(name) == keys[-1]:
            after[ids[-1]].add(page_id)


def databases_found(call: Json) -> set[str]:
    return {
        item["id"]
        for item in call["reply"]["results"] if item["object"] == "database"
    }


def predates(call: Json, calls: list[Json], databases: Json) -> list[str]:
    """Databases a search missed because it ran before they existed.

    Args:
        call (Json): a recorded search.
        calls (list[Json]): every recorded call.
        databases (Json): databases by id.

    Returns:
        list[str]: titles the same search finds elsewhere in the recordings.
    """
    mine = databases_found(call)
    missing: set[str] = set()
    for other in calls:
        if other["tool"] == call["tool"] and other["args"] == call["args"]:
            theirs = databases_found(other)
            if mine < theirs:
                missing |= theirs - mine
    return sorted("".join(part["plain_text"]
                          for part in databases[db_id]["title"])
                  for db_id in missing)


def stored_call(call: Json, calls: list[Json], databases: Json,
                blocks: Json) -> Json:
    """One call as the corpus keeps it.

    Args:
        call (Json): the recorded call.
        calls (list[Json]): every recorded call.
        databases (Json): databases by id.
        blocks (Json): the rows block per database.

    Returns:
        Json: the call, its reply's envelope and result ids, and either
        ``next: unrecorded`` or a ``skip`` reason when the recordings
        cannot hold what a replay would need.
    """
    reply = call["reply"]
    args = call["args"]
    out: Json = {"task": call["task"], "tool": call["tool"], "args": args}
    stored = {
        k: v
        for k, v in reply.items() if k not in ("results", "request_id")
    }
    stored["results"] = [item["id"] for item in reply["results"]]
    out["reply"] = stored
    missed = predates(call, calls, databases)
    if missed:
        out["skip"] = (f"recorded before {', '.join(missed)} existed; the "
                       "same search elsewhere in the recordings finds them")
    if call["tool"] != "API-post-database-query":
        known = {
            row_id
            for block in blocks.values()
            for row_id in block["cells"]
        }
        if reply["has_more"] and reply["next_cursor"] not in known:
            out["next"] = "unrecorded"
        return out
    cells = blocks[args["database_id"]]["cells"]
    need = read_columns(call, databases[args["database_id"]]["properties"])
    for item in reply["results"]:
        missing = sorted(need - set(cells[item["id"]]))
        if missing:
            out["skip"] = (f"{item['id']} is recorded without "
                           f"{', '.join(missing)}, which the call reads, and "
                           "no reply proves its value")
            break
    following = reply["next_cursor"]
    if reply["has_more"] and (following not in cells
                              or need - set(cells[following])):
        out["next"] = "unrecorded"
    return out


def dump(corpus: Json) -> str:
    """The corpus as indented JSON with each row and result list on one line.

    Args:
        corpus (Json): the corpus.

    Returns:
        str: the file's text.
    """
    inline: list[str] = []

    def mark(value: Any) -> str:
        inline.append(json.dumps(value, ensure_ascii=False))
        return f"\0{len(inline) - 1}\0"

    shaped = {
        **corpus,
        "tables": [{
            **table, "rows": [mark(row) for row in table["rows"]]
        } for table in corpus["tables"]],
        "calls": [{
            **call, "reply": {
                **call["reply"], "results": mark(call["reply"]["results"])
            }
        } for call in corpus["calls"]],
    }
    text = json.dumps(shaped, indent=2, ensure_ascii=False)
    return re.sub(r'"\\u0000(\d+)\\u0000"', lambda m: inline[int(m.group(1))],
                  text) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--parquet", type=Path, help="a local copy to read")
    opts = parser.parse_args()
    if opts.parquet is not None:
        calls = load_calls(opts.parquet)
    else:
        with tempfile.TemporaryDirectory() as scratch:
            parquet = Path(scratch) / "MCP-Atlas.parquet"
            urllib.request.urlretrieve(URL, parquet)
            calls = load_calls(parquet)
    databases, users, blocks = gather(calls)
    check_rebuild(calls, databases, blocks)
    infer_cells(calls, databases, blocks)
    order = row_order(calls, databases, blocks)
    known = {
        page_id
        for block in blocks.values()
        for page_id in block["cells"]
    }
    tables = []
    for db_id, db in databases.items():
        block = blocks.get(db_id)
        columns = list(db["properties"])
        rows = [] if block is None else [
            [page_id, block["urls"].get(page_id)] +
            [block["cells"][page_id].get(name) for name in columns]
            for page_id in order[db_id]
        ]
        tables.append({
            "database":
            db,
            "created_time":
            block["created_time"] if block else None,
            "last_edited_time":
            block["last_edited_time"] if block else None,
            "author":
            block["author"] if block else None,
            "columns":
            columns,
            "rows":
            rows,
        })
    corpus = {
        "source": {
            "dataset": "ScaleAI/MCP-Atlas",
            "revision": REVISION,
            "license": "CC-BY-4.0",
            "server": "@notionhq/notion-mcp-server@1.8.1",
            "notion_version": "2022-06-28",
        },
        "users": users,
        "tables": tables,
        "calls":
        [stored_call(call, calls, databases, blocks) for call in calls],
    }
    OUT.write_text(dump(corpus))
    print(f"{OUT.relative_to(ROOT)}: {len(calls)} calls, {len(known)} rows")


if __name__ == "__main__":
    main()
