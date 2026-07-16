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

import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
import uuid  # noqa: E402

import boto3  # noqa: E402
from moto.server import ThreadedMotoServer  # noqa: E402
from pymongo import AsyncMongoClient  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.mongodb import MongoDBConfig  # noqa: E402
from mirage.resource.mongodb import MongoDBResource  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.resource.redis import RedisResource  # noqa: E402
from mirage.resource.s3 import S3Config, S3Resource  # noqa: E402
from mirage.types import CommandSafeguard, PathSpec  # noqa: E402

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
DB = "mirage_integ_runtime"
BUCKET = "mirage-integ-runtime"

SLOW_SCRIPT = """\
n = 0
for i in range(300000000):
    n = n + 1
"""

ANALYZE_SCRIPT = """\
from pathlib import Path
ram = Path('/ram/data.txt').read_text().strip()
s3 = Path('/s3/greeting.txt').read_text().strip()
print('ram:', ram)
print('s3:', s3)
print('argv sum:', int(argv[1]) + int(argv[2]))
"""

CASES: list[tuple[str, str]] = [
    ("py3_ram_read", "python3 -c \"from pathlib import Path; "
     "print(Path('/ram/data.txt').read_text().strip().upper())\""),
    ("py3_redis_read", "python3 -c \"from pathlib import Path; "
     "print(Path('/redis/notes.txt').read_text().strip())\""),
    ("py3_s3_read", "python3 -c \"from pathlib import Path; "
     "print(Path('/s3/greeting.txt').read_text().strip())\""),
    ("py3_mongodb_meta", "python3 -c \"import json; from pathlib import Path; "
     f"meta = json.loads(Path('/mongodb/{DB}/database.json').read_text()); "
     "print(meta['database'], len(meta['collections']))\""),
    ("py3_mongodb_schema",
     "python3 -c \"import json; from pathlib import Path; "
     f"s = json.loads(Path('/mongodb/{DB}/collections/books/schema.json')"
     ".read_text()); "
     "print(s['name'], s['kind'], s['document_count'], "
     "[f['path'] for f in s['fields']])\""),
    ("py3_mongodb_docs", "python3 -c \"from pathlib import Path; "
     f"lines = Path('/mongodb/{DB}/collections/books/documents.jsonl')"
     ".read_text().splitlines(); "
     "print('books:', len(lines))\""),
    ("py3_script_argv", "python3 /ram/analyze.py 40 2"),
    ("py3_write_back", "python3 -c \"from pathlib import Path; "
     "Path('/ram/out.txt').write_text('written-by-python3')\" "
     "&& cat /ram/out.txt"),
    ("python_alias", "python -c 'print(6 * 7)'"),
    ("py3_env", "export GREETING=hello-runtime && "
     "python3 -c \"import os; print(os.getenv('GREETING'))\""),
    ("py3_iterdir", "python3 -c \"from pathlib import Path; "
     "print(sorted(str(p).split('/')[-1] "
     "for p in Path('/ram').iterdir()))\""),
]

ERROR_CASES: list[tuple[str, str]] = [
    ("py3_missing_file", "python3 -c \"from pathlib import Path; "
     "print(Path('/ram/nope.txt').read_text())\""),
    ("py3_host_fs_invisible", "python3 -c \"from pathlib import Path; "
     "print(Path('/etc/passwd').read_text())\""),
]

PY_ONLY_CASES: list[tuple[str, str]] = [
    ("py3_builtin_open",
     "python3 -c \"print(open('/ram/data.txt').read().strip())\""),
    ("py3_builtin_open_write",
     "python3 -c \"f = open('/ram/open_out.txt', 'w'); "
     "f.write('written-by-open'); f.close()\" && cat /ram/open_out.txt"),
]


async def _seed_mongo() -> None:
    client = AsyncMongoClient(MONGODB_URI)
    try:
        await client.drop_database(DB)
        db = client[DB]
        await db["books"].insert_many([
            {
                "_id": 1,
                "title": "alpha"
            },
            {
                "_id": 2,
                "title": "beta"
            },
        ])
        await db["authors"].insert_many([{"_id": 1, "name": "ada"}])
    finally:
        await client.close()


def _put_s3(endpoint: str, key: str, body: bytes) -> None:
    client = boto3.client(
        "s3",
        region_name="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    client.put_object(Bucket=BUCKET, Key=key, Body=body)


def _seed_s3(endpoint: str) -> None:
    client = boto3.client(
        "s3",
        region_name="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    client.create_bucket(Bucket=BUCKET)
    _put_s3(endpoint, "greeting.txt", b"hello from s3\n")
    _put_s3(endpoint, "cache_inval.txt", b"seeded-cold\n")
    _put_s3(endpoint, "warm.txt", b"cold-bytes\n")


def _build_workspace(endpoint: str, run_id: str) -> Workspace:
    ram = RAMResource()
    ram._store.files["/data.txt"] = b"hello from ram\n"
    ram._store.files["/analyze.py"] = ANALYZE_SCRIPT.encode()
    redis = RedisResource(url=REDIS_URL,
                          key_prefix=f"mirage-integ-runtime-{run_id}/")
    s3 = S3Resource(
        S3Config(bucket=BUCKET,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    mongodb = MongoDBResource(
        config=MongoDBConfig(uri=MONGODB_URI, databases=[DB]))
    return Workspace(
        {
            "/ram": ram,
            "/redis": redis,
            "/s3": s3,
            "/mongodb": mongodb,
        },
        mode=MountMode.EXEC,
    )


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    if out:
        print(out, end="" if out.endswith("\n") else "\n")


async def _run_error(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    print(f"=== {name} ===")
    print(f"exit_code={result.exit_code}")


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    try:
        host, port = server.get_host_and_port()
        endpoint = f"http://{host}:{port}"
        _seed_s3(endpoint)
        await _seed_mongo()
        run_id = uuid.uuid4().hex[:8]
        ws = _build_workspace(endpoint, run_id)
        await ws.execute("echo redis says hi > /redis/notes.txt")
        for name, cmd in CASES:
            await _run(ws, name, cmd)
        for name, cmd in ERROR_CASES:
            await _run_error(ws, name, cmd)

        # Sandbox I/O shares the shell file cache (s3 caches reads).
        # Invalidate: prime the cache with cat (applyIo populates it
        # after the command), then a sandbox write must drop the entry
        # so the follow-up cat re-fetches the new bytes.
        await _run(ws, "s3_inval_prime", "cat /s3/cache_inval.txt")
        await _run(
            ws, "py3_s3_cache_invalidate",
            "python3 -c \"from pathlib import Path; "
            "Path('/s3/cache_inval.txt').write_text('updated-by-sandbox')\" "
            "&& cat /s3/cache_inval.txt")
        # Warm read: prime, mutate the backend out of band, and the
        # sandbox read (LAZY, never revalidated) must keep serving the
        # cached bytes instead of hitting the backend.
        await _run(ws, "s3_warm_prime", "cat /s3/warm.txt")
        _put_s3(endpoint, "warm.txt", b"hot-bytes\n")
        await _run(
            ws, "py3_s3_warm_read", "python3 -c \"from pathlib import Path; "
            "print(Path('/s3/warm.txt').read_text().strip())\"")

        # Op safeguards bind to the executing (post-symlink-follow)
        # mount: a sandbox read through a link on an unsafeguarded
        # mount still gets the target mount's byte cap.
        ws_link = Workspace(
            {
                "/data": (RAMResource(), MountMode.EXEC, {
                    "read": CommandSafeguard(max_bytes=8)
                }),
                "/r":
                RAMResource(),
            },
            mode=MountMode.EXEC)
        await ws_link.execute("echo 0123456789abcdef > /data/big.txt")
        await ws_link.execute("ln -s /data/big.txt /r/link")
        await _run(
            ws_link, "sbx_link_guard",
            "python3 -c \"from pathlib import Path; "
            "print(Path('/r/link').read_text())\"")
        await ws_link.close()

        # Cross-mount rename through dispatch: both languages address
        # the dst against the source mount, so the file lands on the
        # source backend under the dst's virtual path (EXDEV follow-up).
        ws_mv = Workspace({
            "/a": RAMResource(),
            "/b": RAMResource()
        },
                          mode=MountMode.EXEC)
        await ws_mv.execute("echo moved-bytes > /a/x.txt")
        await ws_mv.dispatch("rename",
                             PathSpec.from_str_path("/a/x.txt"),
                             dst=PathSpec.from_str_path("/b/y.txt"))
        await _run(ws_mv, "xmount_rename", "cat /a/b/y.txt")
        await _run_error(ws_mv, "xmount_rename_src", "cat /a/x.txt")
        await _run_error(ws_mv, "xmount_rename_dst_mount", "cat /b/y.txt")
        await ws_mv.close()

        for name, cmd in PY_ONLY_CASES:
            await _run(ws, name, cmd)

        ws_local = Workspace({"/ram": RAMResource()},
                             mode=MountMode.EXEC,
                             python_runtime="local")
        result = await ws_local.execute(
            'python3 -c "import sys; print(sys.argv[1:])" alpha beta')
        print("=== py3_local_runtime_argv ===")
        print(await result.stdout_str(), end="")
        await ws_local.close()

        slow_ram = RAMResource()
        slow_ram._store.files["/slow.py"] = SLOW_SCRIPT.encode()
        ws_sg = Workspace(
            {
                "/ram": (slow_ram, MountMode.EXEC, {
                    "python3": CommandSafeguard(timeout_seconds=1)
                })
            },
            mode=MountMode.EXEC)
        result = await ws_sg.execute("python3 /ram/slow.py")
        print("=== py3_safeguard_timeout ===")
        print(f"exit_code={result.exit_code}")
        await ws_sg.close()
        await ws.close()
    finally:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())
