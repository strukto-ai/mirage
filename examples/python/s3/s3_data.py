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
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

backend = S3Resource(config)
ws = Workspace({"/s3/": backend}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


PARQUET = "/s3/data/example.parquet"
ORC = "/s3/data/example.orc"
FEATHER = "/s3/data/example.feather"
HDF5 = "/s3/data/example.h5"


async def main():
    print("=== PLAN: estimate bytes before execution ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- {label} ---")
        for cmd in [
                f"cat {path}", f"head -n 3 {path}", f"wc -l {path}",
                f"stat {path}"
        ]:
            dr = await ws.execute(cmd, provision=True)
            net = dr.network_read
            cache = dr.cache_read
            print(f"  {cmd.split()[0]:6s}: net={net}, cache={cache}, "
                  f"ops={dr.read_ops}, {dr.precision}")
        print()

    print(f"Stats after plans (should be 0): {ops_summary()}\n")

    print("=== CAT: schema + preview ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- cat {label} ---")
        result = await ws.execute(f"cat {path}")
        print(await result.stdout_str())

    print(f"Stats after cat: {ops_summary()}\n")

    print("=== HEAD: first 3 rows ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- head -n 3 {label} ---")
        result = await ws.execute(f"head -n 3 {path}")
        print(await result.stdout_str())

    print("=== TAIL: last 3 rows ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- tail -n 3 {label} ---")
        result = await ws.execute(f"tail -n 3 {path}")
        print(await result.stdout_str())

    print("=== WC: row count ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        result = await ws.execute(f"wc -l {path}")
        print(f"  {label}: {(await result.stdout_str()).strip()} rows")
    print()

    print("=== STAT: metadata ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- stat {label} ---")
        result = await ws.execute(f"stat {path}")
        print(await result.stdout_str())

    print("=== GREP: search for 'item_5' (via cat) ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- cat {label} | grep item_5 ---")
        result = await ws.execute(f"cat {path} | grep item_5")
        print(f"  {(await result.stdout_str()).strip()}")
    print()

    print("=== CUT: select 'id,label' columns ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        print(f"--- cut -f id,label {label} ---")
        result = await ws.execute(f"cut -f id,label {path}")
        print(await result.stdout_str())

    print("=== CACHE: plan after data is cached ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        dr = await ws.execute(f"cat {path}", provision=True)
        print(f"  {label}: net={dr.network_read}, cache={dr.cache_read}, "
              f"hits={dr.cache_hits}")
    print()

    print("=== PIPES: filetype commands in pipelines ===\n")

    print("--- cat parquet | grep item_3 ---")
    result = await ws.execute(f"cat {PARQUET} | grep item_3")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- head -n 5 parquet | wc -l ---")
    result = await ws.execute(f"head -n 5 {PARQUET} | wc -l")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n=== LS -L: long listing ===\n")

    result = await ws.execute("ls -l /s3/data/")
    print(await result.stdout_str())

    print("=== FILE: rich type detection ===\n")

    for label, path in [("parquet", PARQUET), ("orc", ORC),
                        ("feather", FEATHER), ("hdf5", HDF5)]:
        result = await ws.execute(f"file {path}")
        print(f"  {label}: {(await result.stdout_str()).strip()}")
    print()

    print("=== GLOB: cat / head across files via *.ext ===\n")

    print("--- cat /s3/data/*.parquet | grep item_5 ---")
    result = await ws.execute("cat /s3/data/*.parquet | grep item_5")
    print(f"  exit={result.exit_code}")
    for line in (await result.stdout_str()).strip().splitlines():
        print(f"  {line}")

    print("\n--- cat /s3/data/*.orc | grep item_3 ---")
    result = await ws.execute("cat /s3/data/*.orc | grep item_3")
    print(f"  exit={result.exit_code}")
    for line in (await result.stdout_str()).strip().splitlines():
        print(f"  {line}")

    print("\n--- head -n 2 /s3/data/*.feather ---")
    result = await ws.execute("head -n 2 /s3/data/*.feather")
    print(f"  exit={result.exit_code}")
    for line in (await result.stdout_str()).strip().splitlines():
        print(f"  {line}")

    print(f"\nFinal stats: {ops_summary()}")


asyncio.run(main())
