import asyncio
import os
import uuid

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.types import PathSpec
from mirage.vfs.nextcloud import NextcloudConfig, NextcloudVFS

load_dotenv(".env.development")

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME"),
    password=os.environ.get("NEXTCLOUD_PASSWORD"),
)
vfs = NextcloudVFS(config)
ws = Workspace({"/nc/": vfs}, mode=MountMode.WRITE)


async def main():
    print("=== ls /nc/ ===")
    r = await ws.shell("ls /nc/")
    print(await r.stdout_str())

    print("=== tree -L 2 /nc/ ===")
    r = await ws.shell("tree -L 2 /nc/")
    print(await r.stdout_str())

    print("=== find /nc/ -type f ===")
    r = await ws.shell("find /nc/ -type f")
    print(await r.stdout_str())

    print("=== stat /nc/ ===")
    r = await ws.shell("stat /nc/")
    print((await r.stdout_str()).strip())

    test_file = f"/nc/mirage-demo-{uuid.uuid4().hex[:8]}.txt"
    body = b"hello from mirage\nline two\nthird line\n"

    print(f"\n=== write {test_file} ===")
    await ws.vfs.write(test_file, body)
    print(f"  wrote {len(body)} bytes")

    print(f"\n=== cat {test_file} ===")
    r = await ws.shell(f"cat {test_file}")
    print(await r.stdout_str())

    print(f"=== wc -l {test_file} ===")
    r = await ws.shell(f"wc -l {test_file}")
    print((await r.stdout_str()).strip())

    print(f"=== head -n 2 {test_file} ===")
    r = await ws.shell(f"head -n 2 {test_file}")
    print(await r.stdout_str())

    print(f"=== grep line {test_file} ===")
    r = await ws.shell(f"grep line {test_file}")
    print(await r.stdout_str())

    print(f"=== sort {test_file} | uniq ===")
    r = await ws.shell(f"sort {test_file} | uniq")
    print(await r.stdout_str())

    print(f"=== cat {test_file} | tr a-z A-Z ===")
    r = await ws.shell(f"cat {test_file} | tr a-z A-Z")
    print(await r.stdout_str())

    print(f"=== sha256sum {test_file} ===")
    r = await ws.shell(f"sha256sum {test_file}")
    print((await r.stdout_str()).strip())

    # chmod/chown/touch never hit the WebDAV server: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {test_file} ===")
    meta_res = await ws.shell(f'chmod 640 "{test_file}"'
                              f' && chown 500:dev "{test_file}"'
                              f' && touch -t 202601021530 "{test_file}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat", PathSpec.from_str_path(test_file))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    print(f"\n=== rm {test_file} ===")
    r = await ws.shell(f"rm {test_file}")
    print(f"  exit={r.exit_code}")

    print(f"=== stat {test_file} (expect failure) ===")
    r = await ws.shell(f"stat {test_file}")
    print(
        f"  exit={r.exit_code}  stderr={(await r.stderr_str()).strip()[:80]}")


if __name__ == "__main__":
    asyncio.run(main())
