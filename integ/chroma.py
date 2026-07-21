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

import asyncio
import base64
import gzip
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import chromadb  # noqa: E402
from cases import run_provision_probe  # noqa: E402
from cases import run_not_found, run_sed_readonly_probe  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.chroma import ChromaConfig, ChromaResource  # noqa: E402

CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
EMBED_DIM = 8
MOUNT = "/knowledge/"

PATH_TREE: dict[str, dict] = {
    "guides/quickstart.md": {
        "size": 180,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-02-01T00:00:00Z",
    },
    "guides/auth.md": {
        "size": 190,
        "created_at": "2026-01-15T00:00:00Z",
        "updated_at": "2026-02-15T00:00:00Z",
    },
    "policies/refunds.md": {
        "size": 150,
        "created_at": "2026-02-01T00:00:00Z",
        "updated_at": "2026-03-01T00:00:00Z",
    },
    "policies/privacy.md": {
        "size": 120,
        "created_at": "2026-02-10T00:00:00Z",
        "updated_at": "2026-03-10T00:00:00Z",
    },
    "CHANGELOG.md": {
        "size": 90,
    },
    # No size metadata: sizeless files count as 0 for -size/du, never dropped.
    "policies/archived.md": {
        "created_at": "2026-03-01T00:00:00Z",
    },
}

CHUNKS: dict[str, list[dict]] = {
    "policies/archived.md": [
        {
            "document": "Archived policy retained for records.",
            "metadata": {
                "page_slug": "policies/archived.md",
                "chunk_index": 0
            },
        },
    ],
    "guides/quickstart.md": [
        {
            "document":
            "Welcome to Acme. This quickstart gets you running fast.",
            "metadata": {
                "page_slug": "guides/quickstart.md",
                "chunk_index": 0
            },
        },
        {
            "document":
            "Install the CLI with npm i -g acme then run acme login.",
            "metadata": {
                "page_slug": "guides/quickstart.md",
                "chunk_index": 1
            },
        },
        {
            "document":
            "Set your token in the ACME_TOKEN environment variable.",
            "metadata": {
                "page_slug": "guides/quickstart.md",
                "chunk_index": 2
            },
        },
    ],
    "guides/auth.md": [
        {
            "document":
            "Authentication uses bearer tokens via the Authorization header.",
            "metadata": {
                "page_slug": "guides/auth.md",
                "chunk_index": 0
            },
        },
        {
            "document":
            "Requests are rate limited to 100 calls per minute per token.",
            "metadata": {
                "page_slug": "guides/auth.md",
                "chunk_index": 1
            },
        },
        {
            "document":
            "If you exceed the limit you receive HTTP 429 and must back off.",
            "metadata": {
                "page_slug": "guides/auth.md",
                "chunk_index": 2
            },
        },
    ],
    "policies/refunds.md": [
        {
            "document": "Refunds are available within 30 days of purchase.",
            "metadata": {
                "page_slug": "policies/refunds.md",
                "chunk_index": 0
            },
        },
        {
            "document": "Email support to start a refund with your order id.",
            "metadata": {
                "page_slug": "policies/refunds.md",
                "chunk_index": 1
            },
        },
        {
            "document":
            "Approved refunds are processed within five business days.",
            "metadata": {
                "page_slug": "policies/refunds.md",
                "chunk_index": 2
            },
        },
    ],
    "policies/privacy.md": [
        {
            "document":
            "Customer data is stored encrypted at rest and in transit.",
            "metadata": {
                "page_slug": "policies/privacy.md",
                "chunk_index": 0
            },
        },
        {
            "document": "We never sell personal information to third parties.",
            "metadata": {
                "page_slug": "policies/privacy.md",
                "chunk_index": 1
            },
        },
    ],
    "CHANGELOG.md": [
        {
            "document": "v2.0 added rate limit headers and refund automation.",
            "metadata": {
                "page_slug": "CHANGELOG.md",
                "chunk_index": 0
            },
        },
    ],
}

CASES: list[tuple[str, str]] = [
    ("ls", "ls {root}"),
    ("ls_guides", "ls {root}guides/"),
    ("find_md", "find {root} -name '*.md'"),
    ("find_type_f", "find {root} -type f | sort"),
    ("find_root_maxdepth0", "find {root} -maxdepth 0"),
    ("find_root_name", "find {root} -name knowledge"),
    ("find_size_plus_100c", "find {root} -type f -size +100c | sort"),
    ("find_size_archived_kept",
     "find {root}policies/ -name 'archived*' -size -1k"),
    # cold (bespoke) then warm (cache-mount generic) must be identical
    ("grep_cold_single", "grep bearer {root}guides/auth.md"),
    ("grep_warm_single", "grep bearer {root}guides/auth.md"),
    ("cat_auth", "cat {root}guides/auth.md"),
    ("cat_quickstart", "cat {root}guides/quickstart.md"),
    ("head_1", "head -n 1 {root}guides/quickstart.md"),
    ("tail_1", "tail -n 1 {root}guides/quickstart.md"),
    ("grep_429", "grep 429 {root}guides/auth.md"),
    ("grep_e_multi", "grep -e bearer -e 429 {root}guides/auth.md"),
    ("grep_c_rate", "grep -c rate {root}guides/auth.md"),
    ("grep_r_refund", "grep -r refund {root}policies/"),
    ("grep_cold_count", "grep -c sell {root}policies/privacy.md"),
    ("grep_warm_count", "grep -c sell {root}policies/privacy.md"),
    ("grep_rl_encrypted", "grep -rl encrypted {root}"),
    ("grep_v_bearer", "grep -v bearer {root}guides/auth.md"),
    ("grep_rE_alternation", 'grep -rE "rate limited|refund" {root}'),
    ("wc_l_auth", "wc -l {root}guides/auth.md"),
    ("sort_auth", "sort {root}guides/auth.md"),
    ("uniq_auth", "uniq {root}guides/auth.md"),
    ("uniq_w0_auth", "uniq -w 0 {root}guides/auth.md"),
    ("stat_name_auth", 'stat -c "%n" {root}guides/auth.md'),
    ("cut_d_f1", "cut -d ' ' -f 1 {root}guides/quickstart.md"),
    ("awk_first_word", "awk '{{print $1}}' {root}guides/quickstart.md"),
    ("sed_upper_acme", "sed s/Acme/ACME/ {root}guides/quickstart.md"),
    ("rg_l_token", "rg -l token {root}"),
    ("pipe_cat_wc", "cat {root}guides/auth.md | wc -l"),
    ("pipe_sort_uniq_wc", "cat {root}policies/refunds.md | sort | uniq"
     " | wc -l"),
    # cat cache poisoning: per-file cache keys after a concat cat
    ("poison_concat", "cat {root}guides/quickstart.md {root}guides/auth.md"),
    ("poison_first_intact", "cat {root}guides/quickstart.md"),
    ("poison_second_intact", "cat {root}guides/auth.md"),
    ("pipe_concat_head",
     "cat {root}guides/quickstart.md {root}guides/auth.md | head -n 1"),
    # du has no native op -> exercises the stat/readdir walk fallback,
    # which must match the Python du builder byte for byte.
    ("du_guides", "du {root}guides"),
    ("du_root", "du {root}"),
    ("du_c_multi", "du -c {root}guides {root}policies"),
    # symlink into the mount: links are namespace state, so they work on a
    # read-only backend (no backend write happens)
    ("sym_ln", "ln -s {root}guides/auth.md {root}meta_link"),
    ("sym_readlink", "readlink {root}meta_link"),
    ("sym_cat", "cat {root}meta_link"),
    ("sym_wc", "wc -l {root}meta_link"),
    ("sym_ls", "ls -F {root} | grep meta_link"),
    ("sym_rm", "rm {root}meta_link && ls {root}"),
]


def encoded_path_tree() -> str:
    # gzip+base64 variant so the integ covers parse_path_tree's
    # encoded branch (unit tests cover the plain JSON branch)
    raw = json.dumps(PATH_TREE).encode()
    return base64.b64encode(gzip.compress(raw)).decode()


def embedding_for(position: int) -> list[float]:
    vector = [0.0] * EMBED_DIM
    vector[position % EMBED_DIM] = 1.0
    return vector


async def seed_collection(collection_name: str) -> None:
    client = await chromadb.AsyncHttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    collection = await client.create_collection(collection_name)
    ids = ["__path_tree__"]
    documents = [encoded_path_tree()]
    metadatas: list[dict] = [{"kind": "path_tree"}]
    embeddings = [embedding_for(0)]
    position = 1
    for chunks in CHUNKS.values():
        for chunk in chunks:
            slug = chunk["metadata"]["page_slug"]
            index = chunk["metadata"]["chunk_index"]
            ids.append(f"{slug}#{index}")
            documents.append(chunk["document"])
            metadatas.append(chunk["metadata"])
            embeddings.append(embedding_for(position))
            position += 1
    await collection.add(ids=ids,
                         documents=documents,
                         metadatas=metadatas,
                         embeddings=embeddings)


async def run_case(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")


async def main() -> None:
    collection_name = f"mirage-integ-{uuid.uuid4().hex[:8]}"
    await seed_collection(collection_name)
    config = ChromaConfig(
        host=CHROMA_HOST,
        port=CHROMA_PORT,
        collection_name=collection_name,
    )
    ws = Workspace({MOUNT: ChromaResource(config=config)}, mode=MountMode.READ)
    # Vector search (the `search` command) is not exercised here: the thin
    # client ships no embedding function for query_texts. It is covered by
    # unit tests (tests/core/chroma/test_search.py).
    for name, tmpl in CASES:
        await run_case(ws, name, tmpl.format(root=MOUNT))
    await run_not_found(ws, MOUNT)
    await run_provision_probe(ws, f"{MOUNT}guides/auth.md")
    await run_sed_readonly_probe(ws, f"{MOUNT}guides/auth.md")


if __name__ == "__main__":
    asyncio.run(main())
