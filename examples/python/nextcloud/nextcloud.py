import asyncio
import os
import uuid

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource

load_dotenv(".env.development")

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME"),
    password=os.environ.get("NEXTCLOUD_PASSWORD"),
)
resource = NextcloudResource(config)
ws = Workspace({"/nc/": resource}, mode=MountMode.WRITE)


async def main():
    print("=== ls /nc/ ===")
    r = await ws.execute("ls /nc/")
    print(await r.stdout_str())

    print("=== tree -L 2 /nc/ ===")
    r = await ws.execute("tree -L 2 /nc/")
    print(await r.stdout_str())

    print("=== find /nc/ -type f ===")
    r = await ws.execute("find /nc/ -type f")
    print(await r.stdout_str())

    print("=== stat /nc/ ===")
    r = await ws.execute("stat /nc/")
    print((await r.stdout_str()).strip())

    test_file = f"/nc/mirage-demo-{uuid.uuid4().hex[:8]}.txt"
    body = b"hello from mirage\nline two\nthird line\n"

    print(f"\n=== write {test_file} ===")
    await ws.ops.write(test_file, body)
    print(f"  wrote {len(body)} bytes")

    print(f"\n=== cat {test_file} ===")
    r = await ws.execute(f"cat {test_file}")
    print(await r.stdout_str())

    print(f"=== wc -l {test_file} ===")
    r = await ws.execute(f"wc -l {test_file}")
    print((await r.stdout_str()).strip())

    print(f"=== head -n 2 {test_file} ===")
    r = await ws.execute(f"head -n 2 {test_file}")
    print(await r.stdout_str())

    print(f"=== grep line {test_file} ===")
    r = await ws.execute(f"grep line {test_file}")
    print(await r.stdout_str())

    print(f"=== sort {test_file} | uniq ===")
    r = await ws.execute(f"sort {test_file} | uniq")
    print(await r.stdout_str())

    print(f"=== cat {test_file} | tr a-z A-Z ===")
    r = await ws.execute(f"cat {test_file} | tr a-z A-Z")
    print(await r.stdout_str())

    print(f"=== sha256sum {test_file} ===")
    r = await ws.execute(f"sha256sum {test_file}")
    print((await r.stdout_str()).strip())

    print(f"\n=== rm {test_file} ===")
    r = await ws.execute(f"rm {test_file}")
    print(f"  exit={r.exit_code}")

    print(f"=== stat {test_file} (expect failure) ===")
    r = await ws.execute(f"stat {test_file}")
    print(
        f"  exit={r.exit_code}  stderr={(await r.stderr_str()).strip()[:80]}")


if __name__ == "__main__":
    asyncio.run(main())
