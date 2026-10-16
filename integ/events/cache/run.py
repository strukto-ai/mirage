import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aioboto3

from mirage import MountMode, Workspace
from mirage.cache.index import IndexConfig
from mirage.events import EventHub, RAMEventQueue
from mirage.types import FileChangeKind, FileEvent, PathSpec
from mirage.vfs.s3 import S3VFS, S3Config


class ArmedQueue(RAMEventQueue):
    """Expose subscriber readiness without timing-dependent sleeps."""

    def __init__(self, root: PathSpec) -> None:
        super().__init__(root)
        self.armed = asyncio.Event()

    async def pop(self) -> FileEvent:
        self.armed.set()
        return await super().pop()


async def check(ws: Workspace, root: str, expected: dict) -> None:
    """Args:
    ws (Workspace): Subscribed workspace.
    root (str): Virtual root of this isolated case.
    expected (dict): Shell command and exact expected result.
    """
    command = expected["command"].replace("{root}", root)
    result = await ws.shell(command)
    out = await result.stdout_str()
    err = await result.stderr_str()
    assert (result.exit_code, out, err) == (
        expected.get("exit", 0),
        expected["stdout"],
        "",
    ), (command, result.exit_code, out, err)


async def run_case(mount: str, case: dict) -> None:
    """Args:
    mount (str): Mount prefix, also repeated in the backend key.
    case (dict): Warm reads, external mutations, event and fresh reads.
    """
    prefix = f"events-cache-{uuid.uuid4().hex}/"
    root = mount + mount
    config = S3Config(
        bucket=os.environ["S3_BUCKET"],
        endpoint_url=os.environ["S3_ENDPOINT"],
        region=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        path_style=True,
        key_prefix=prefix,
    )
    ws = Workspace(
        {mount: S3VFS(config)},
        mode=MountMode.WRITE,
        index=IndexConfig(ttl=600),
    )
    queue = ArmedQueue(PathSpec.from_str_path(root))
    ws.attach_event_runtime(
        EventHub(ws.registry, queue_factory=lambda _roots: queue)
    )
    stream = ws.events(root)
    pending = None
    touched: set[str] = set()

    def key(relative: str) -> str:
        return prefix + mount.strip("/") + "/" + relative

    async with aioboto3.Session().client(
        "s3",
        endpoint_url=config.endpoint_url,
        region_name=config.region,
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    ) as client:
        try:
            for relative, body in case["seed"].items():
                touched.add(key(relative))
                await client.put_object(
                    Bucket=config.bucket, Key=key(relative), Body=body.encode()
                )
            for expected in case["warm"]:
                await check(ws, root, expected)
            for relative, body in case.get("write", {}).items():
                touched.add(key(relative))
                await client.put_object(
                    Bucket=config.bucket, Key=key(relative), Body=body.encode()
                )
            for relative in case.get("delete", []):
                await client.delete_object(
                    Bucket=config.bucket, Key=key(relative)
                )
            for expected in case["warm"]:
                if expected.get("stale", True):
                    await check(ws, root, expected)

            event = case["event"]
            path = root + "/" + event["path"]
            previous = (
                root + "/" + event["previous"] if "previous" in event else None
            )

            async def consume() -> None:
                delivered = await anext(stream)
                assert delivered.kind.value == event["kind"]
                assert delivered.path.virtual == path
                assert delivered.path.vfs_path == path[len(mount) + 1 :]
                assert (
                    delivered.previous_path.virtual
                    if delivered.previous_path
                    else None
                ) == previous
                for expected in case["checks"]:
                    await check(ws, root, expected)

            pending = asyncio.create_task(consume())
            await asyncio.wait_for(queue.armed.wait(), timeout=5)
            await ws.notify(
                FileEvent(
                    kind=FileChangeKind(event["kind"]),
                    path=PathSpec.from_str_path(path),
                    previous_path=PathSpec.from_str_path(previous)
                    if previous
                    else None,
                    timestamp=datetime.now(timezone.utc),
                )
            )
            await asyncio.wait_for(pending, timeout=10)
            print(f"PASS python {mount} {case['id']}")
        finally:
            await ws.close()
            try:
                if pending is not None:
                    await pending
            finally:
                await stream.aclose()
                for stale_key in touched:
                    await client.delete_object(
                        Bucket=config.bucket, Key=stale_key
                    )


async def main() -> None:
    spec = json.loads(Path(__file__).with_name("cases.json").read_text())
    for mount in spec["mounts"]:
        for case in spec["cases"]:
            await run_case(mount, case)


if __name__ == "__main__":
    asyncio.run(main())
