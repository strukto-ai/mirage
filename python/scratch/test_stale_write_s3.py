import asyncio
import os

import aioboto3

from mirage import MountMode, Workspace
from mirage.agents.file_version import FileVersionTracker, StaleMirageFileError
from mirage.resource.s3 import S3Config, S3Resource


KEY = "mirage-pr-demo/file.txt"
PATH = f"/s3/{KEY}"


async def main() -> None:
    bucket = os.environ["AWS_S3_BUCKET"]
    region = os.environ["AWS_DEFAULT_REGION"]
    profile = os.environ.get("AWS_PROFILE")
    config = S3Config(
        bucket=bucket,
        region=region,
        aws_profile=profile,
    )
    ws = Workspace(
        {"/s3/": S3Resource(config)},
        mode=MountMode.WRITE,
    )

    try:
        tracker = FileVersionTracker(ws)
        content = await tracker.read(PATH)
        stamped = await ws.ops.live_identity(PATH)
        print("1. Agent read:", content.decode().strip())
        print("   Stamped identity:", stamped)

        session = aioboto3.Session(profile_name=profile)
        async with session.client("s3", region_name=region) as s3:
            await s3.put_object(
                Bucket=bucket,
                Key=KEY,
                Body=b"outside-writer-version\n",
            )

        current = await ws.ops.live_identity(PATH)
        print("2. Outside writer replaced the object")
        print("   Current identity:", current)

        try:
            await tracker.write(PATH, "agent-version\n")
            print("3. ERROR: stale write was accepted")
        except StaleMirageFileError as exc:
            print("3. PASS: stale write was refused")
            print("  ", exc)

        final = await ws.ops.read(PATH, fresh=True)
        print("4. Final S3 content:", final.decode().strip())
    finally:
        await ws.close()


asyncio.run(main())
