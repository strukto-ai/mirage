import asyncio
import os

import aioboto3

from mirage import MountMode, Workspace
from mirage.agents.file_version import FileVersionTracker, StaleMirageFileError
from mirage.resource.s3 import S3Config, S3Resource

KEY = "mirage-pr-demo/file.txt"
PATH = f"/s3/{KEY}"


async def put_outside(
    session: aioboto3.Session,
    bucket: str,
    region: str,
    content: bytes,
) -> None:
    async with session.client("s3", region_name=region) as s3:
        await s3.put_object(Bucket=bucket, Key=KEY, Body=content)


async def main() -> None:
    bucket = os.environ["AWS_S3_BUCKET"]
    region = os.environ["AWS_DEFAULT_REGION"]
    profile = os.environ.get("AWS_PROFILE")
    session = aioboto3.Session(profile_name=profile)

    await put_outside(session, bucket, region, b"A: original\n")

    resource = S3Resource(
        S3Config(
            bucket=bucket,
            region=region,
            aws_profile=profile,
        ))
    ws = Workspace({"/s3/": resource}, mode=MountMode.WRITE)

    try:
        tracker = FileVersionTracker(ws)

        first = await tracker.read(PATH)
        print("1. Agent read and stamped:", first.decode().strip())

        await put_outside(session, bucket, region, b"B: outside change\n")
        print("2. Outside writer committed: B: outside change")

        try:
            await tracker.read_for_edit(PATH)
            print("3. ERROR: stale edit preparation was accepted")
        except StaleMirageFileError as exc:
            print("3. PASS: read_for_edit detected the stale baseline")
            print("  ", exc)

        latest = await tracker.read(PATH)
        print("4. Agent re-read and stamped:", latest.decode().strip())

        editable = await tracker.read_for_edit(PATH)
        merged = editable.decode() + "C: agent edit\n"
        await tracker.write_edit(PATH, merged)
        print("5. PASS: edit based on the latest version was accepted")

        final = await ws.ops.read(PATH, fresh=True)
        print("6. Final S3 content:\n" + final.decode(), end="")
    finally:
        await ws.close()


asyncio.run(main())
