import argparse
import asyncio
import json
import os
from collections import Counter
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

import boto3
from redis.asyncio import Redis
from redis.asyncio.client import Monitor, MonitorCommandInfo

from mirage.cache.file.config import RedisCacheConfig
from mirage.cache.index.config import RedisIndexConfig
from mirage.cache.index.constants import ENTRY_PREFIX
from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace

CASES = (
    ("write", "printf replacement > /s3/a.txt", 0, ""),
    ("stat_written", "stat -c %s /s3/a.txt", 0, "11\n"),
    ("stat_sibling", "stat -c %s /s3/b.txt", 0, "7\n"),
    ("warm_directories", "ls -l /s3/", 0, None),
    ("mixed_read", "cat /s3/a.txt /s3/d /s3/empty", 1, "replacement"),
    ("append", "printf tail >> /s3/a.txt", 0, ""),
    ("read_appended", "cat /s3/a.txt", 0, "replacementtail"),
    (
        "find_cold",
        "find /s3 -type f",
        0,
        "/s3/a.txt\n/s3/b.txt\n/s3/d/x.txt\n",
    ),
    (
        "find_warm",
        "find /s3 -type f",
        0,
        "/s3/a.txt\n/s3/b.txt\n/s3/d/x.txt\n",
    ),
    (
        "du_warm",
        "du -a /s3",
        0,
        "15\t/s3/a.txt\n7\t/s3/b.txt\n6\t/s3/d/x.txt\n6\t/s3/d\n0\t/s3/empty\n28\t/s3\n",
    ),
)


async def sample(
    args: argparse.Namespace, number: int, bucket: str
) -> dict[str, Any]:
    prefix = f"trace:{args.label}:{number}:{uuid4().hex}:"
    control = Redis.from_url(args.redis_url, decode_responses=True)
    vfs = S3VFS(
        S3Config(
            bucket=bucket,
            region="us-east-1",
            endpoint_url=args.endpoint_url,
            aws_access_key_id=args.access_key,
            aws_secret_access_key=args.secret_key,
            path_style=True,
        )
    )
    ws = Workspace(
        {"/s3": vfs},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
        cache=RedisCacheConfig(
            url=args.redis_url, key_prefix=prefix + "cache:"
        ),
        index=RedisIndexConfig(url=args.redis_url, key_prefix=prefix + "idx:"),
    )
    traces: dict[str, list[MonitorCommandInfo]] = {
        name: [] for name, *_ in CASES
    }
    barriers: dict[str, asyncio.Event] = {}
    api: Counter[str] = Counter()
    results: dict[str, Any] = {}
    active: str | None = None
    child = None

    if args.host == "typescript":
        environment = dict(os.environ)
        environment["MIRAGE_CACHE_TRACE_CONFIG"] = json.dumps(
            {
                "bucket": bucket,
                "endpoint": args.endpoint_url,
                "accessKey": args.access_key,
                "secretKey": args.secret_key,
                "redisUrl": args.redis_url,
                "prefix": prefix,
            }
        )
        child = await asyncio.create_subprocess_exec(
            "node",
            str(Path(__file__).with_suffix(".mjs")),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            env=environment,
        )

    def called(model: Any, **kwargs: Any) -> None:
        api[model.name] += 1

    async def execute(command: str) -> dict[str, Any]:
        if child is not None:
            assert child.stdin is not None and child.stdout is not None
            child.stdin.write(
                (json.dumps({"command": command}) + "\n").encode()
            )
            await child.stdin.drain()
            answer = await child.stdout.readline()
            if not answer:
                raise RuntimeError(
                    f"TypeScript trace runner exited with {await child.wait()}"
                )
            decoded: dict[str, Any] = json.loads(answer)
            return decoded
        api.clear()
        result = await ws.shell(command)
        return {
            "code": result.exit_code,
            "stdout": await result.stdout_str(),
            "stderr": await result.stderr_str(),
            "calls": dict(api),
        }

    async def collect(monitor: Monitor) -> None:
        nonlocal active
        async for event in monitor.listen():
            command = event["command"]
            if command.startswith(f"ECHO {prefix}trace-begin:"):
                active = command.removeprefix(f"ECHO {prefix}trace-begin:")
            elif command.startswith(f"ECHO {prefix}trace-end:"):
                active = None
            elif active is not None and prefix in command:
                traces[active].append(event)
            barrier = barriers.get(command)
            if barrier is not None:
                barrier.set()

    async def mark(marker: str) -> None:
        barrier = asyncio.Event()
        barriers[f"ECHO {marker}"] = barrier
        await control.echo(marker)
        await asyncio.wait_for(barrier.wait(), timeout=10)

    try:
        warm = await execute("ls -l /s3/")
        assert warm["code"] == 0, warm
        if child is None:
            vfs.accessor.open_client().meta.events.register(
                "before-call.s3", called
            )
        async with control.monitor() as monitor:
            collector = asyncio.create_task(collect(monitor))
            try:
                for name, command, code, output in CASES:
                    await mark(f"{prefix}trace-begin:{name}")
                    result = await execute(command)
                    stdout = result["stdout"]
                    stderr = result["stderr"]
                    await mark(f"{prefix}trace-end:{name}")
                    assert result["code"] == code, (
                        command,
                        result["code"],
                        stderr,
                    )
                    if name == "mixed_read":
                        assert stderr == (
                            "cat: /s3/d: Is a directory\n"
                            "cat: /s3/empty: Is a directory\n"
                        ), stderr
                    else:
                        assert stderr == "", (command, stderr)
                    if output is not None:
                        assert stdout == output, (command, stdout, output)
                    events = traces[name]
                    commands = [event["command"] for event in events]
                    directory_probes = [
                        item
                        for item in commands
                        if item.split(" ", 1)[0] in ("GET", "EXISTS")
                        and any(
                            prefix + "cache:data:/s3/" + path in item
                            for path in ("d", "empty")
                        )
                    ]
                    sibling_evictions = [
                        item
                        for item in commands
                        if item.startswith("DEL ")
                        and prefix + "idx:" + ENTRY_PREFIX + "/s3/b.txt"
                        in item
                    ]
                    results[name] = {
                        "redis_commands": len(events),
                        "redis_by_command": dict(
                            Counter(item.split(" ", 1)[0] for item in commands)
                        ),
                        "s3_calls": result["calls"],
                        "directory_content_probes": len(directory_probes),
                        "sibling_entry_evictions": len(sibling_evictions),
                        "exit_code": result["code"],
                        "stdout": stdout,
                    }
            finally:
                collector.cancel()
                with suppress(asyncio.CancelledError):
                    await collector
        if args.expect_fixed:
            assert results["write"]["sibling_entry_evictions"] == 0, results[
                "write"
            ]
            assert results["stat_written"]["s3_calls"] == {}, results[
                "stat_written"
            ]
            assert results["stat_sibling"]["s3_calls"] == {}, results[
                "stat_sibling"
            ]
            assert results["mixed_read"]["directory_content_probes"] == 0, (
                results["mixed_read"]
            )
            assert (
                results["read_appended"]["s3_calls"].get("GetObject", 0) == 0
            )
            assert results["find_warm"]["s3_calls"] == {}
            assert results["find_warm"]["directory_content_probes"] == 0
            assert results["du_warm"]["s3_calls"] == {}
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / f"{args.label}-{number}.monitor.json").write_text(
            json.dumps(traces, indent=2)
        )
        return results
    finally:
        if child is not None:
            assert child.stdin is not None
            child.stdin.close()
            assert await asyncio.wait_for(child.wait(), timeout=30) == 0
        await ws.close()
        keys = [key async for key in control.scan_iter(match=prefix + "*")]
        if keys:
            await control.delete(*keys)
        await control.aclose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--redis-url", default="redis://127.0.0.1:16379/0")
    parser.add_argument("--endpoint-url", default="http://127.0.0.1:19313")
    parser.add_argument(
        "--access-key", default=os.environ.get("AWS_ACCESS_KEY_ID", "mirage")
    )
    parser.add_argument(
        "--secret-key",
        default=os.environ.get("AWS_SECRET_ACCESS_KEY", "mirage-test-only"),
    )
    parser.add_argument("--label", required=True)
    parser.add_argument(
        "--host", choices=("python", "typescript"), default="python"
    )
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expect-fixed", action="store_true")
    args = parser.parse_args()
    client = boto3.client(
        "s3",
        endpoint_url=args.endpoint_url,
        region_name="us-east-1",
        aws_access_key_id=args.access_key,
        aws_secret_access_key=args.secret_key,
    )
    samples = []
    for number in range(args.runs):
        bucket = "cache-trace-" + uuid4().hex
        client.create_bucket(Bucket=bucket)
        objects = {
            "a.txt": b"old",
            "b.txt": b"sibling",
            "d/x.txt": b"nested",
            "empty/": b"",
        }
        try:
            for key, data in objects.items():
                client.put_object(Bucket=bucket, Key=key, Body=data)
            samples.append(asyncio.run(sample(args, number, bucket)))
        finally:
            client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": key} for key in objects]},
            )
            client.delete_bucket(Bucket=bucket)
    result = {
        "label": args.label,
        "runs": args.runs,
        "metric": (
            "Prefix-scoped Redis commands including Lua calls; "
            "transaction wrappers excluded"
        ),
        "samples": samples,
    }
    (args.output / f"{args.label}.summary.json").write_text(
        json.dumps(result, indent=2)
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
