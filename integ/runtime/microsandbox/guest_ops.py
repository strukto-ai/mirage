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

"""Filesystem probes run through the guest kernel, shared by both host runners."""

import concurrent.futures
import errno
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def filesystem(root):
    assert (root / "seed.txt").read_bytes() == b"seed\n"
    work = root / "work space \u2603"
    work.mkdir()
    (work / "nested").mkdir()
    payload = bytes(range(256)) * 4096
    original = work / "binary \u00e9.dat"
    original.write_bytes(payload)
    assert original.stat().st_size == 1048576
    assert original.read_bytes() == payload
    with original.open("rb") as stream:
        for offset in (0, 17, 65530, 524281, 1048500):
            stream.seek(offset)
            assert stream.read(73) == payload[offset : offset + 73]
    with original.open("ab") as stream:
        stream.write(b"tail\x00\xff")
    assert original.read_bytes() == payload + b"tail\x00\xff"
    with original.open("r+b") as stream:
        stream.truncate(257)
        stream.truncate(4096)
    expected = payload[:257] + bytes(4096 - 257)
    assert original.read_bytes() == expected
    renamed = work / "renamed.dat"
    with original.open("rb") as stream:
        original.rename(renamed)
        assert stream.read() == expected
    assert not original.exists()
    with renamed.open("rb") as stream:
        renamed.unlink()
        assert stream.read() == expected
    text = work / "nested" / "lines.txt"
    text.write_text("first\nneedle\nlast\n")
    assert (
        subprocess.check_output(["grep", "needle", str(text)]) == b"needle\n"
    )
    assert (
        subprocess.check_output(["cat", str(text)]) == b"first\nneedle\nlast\n"
    )
    found = subprocess.check_output(["find", str(work), "-type", "f"]).decode()
    assert str(text) in found
    assert "nested" in os.listdir(work)
    shutil.rmtree(work)
    assert not work.exists()
    (root / "receipt.txt").write_text("guest-filesystem-verified\n")
    return {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
    }


def symlinks(root, scoped=False):
    target = root / "link-target.txt"
    link = root / "relative-link"
    absolute = root / "absolute-link"
    dangling = root / "dangling-link"
    target.write_text("target\n")
    try:
        link.symlink_to("link-target.txt")
        assert os.readlink(link) == "link-target.txt"
        assert link.read_text() == "target\n"
        # Scoped FUSE absolute paths start at its virtual root, not the mountpoint.
        absolute.symlink_to("/link-target.txt" if scoped else str(target))
        # MountCore presents absolute virtual targets relative to the link's directory,
        # so the kernel follows them inside the mount rather than against the host root.
        assert os.readlink(absolute) == "link-target.txt", os.readlink(
            absolute
        )
        assert absolute.read_text() == "target\n"
        dangling.symlink_to(
            "/missing-target" if scoped else str(root / "missing-target")
        )
        assert os.readlink(dangling) == "missing-target", os.readlink(dangling)
        assert not dangling.exists() and dangling.is_symlink()
        return {"symlink": True, "absolute": True, "dangling": True}
    finally:
        for candidate in (link, absolute, dangling):
            if candidate.is_symlink():
                candidate.unlink()
        target.unlink()


def concurrent_files(root):
    def worker(index):
        path = root / f"thread-{index}.bin"
        expected = bytes([index]) * 131072
        for _ in range(3):
            path.write_bytes(expected)
            assert path.read_bytes() == expected
        path.unlink()
        return index

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(worker, range(8))) == list(range(8))
    return {"threads": 8, "rounds": 3}


def readonly(root):
    protected = root / "ro" / "protected.txt"
    assert protected.read_text() == "locked\n"
    for target in (protected, root / "ro" / "new.txt"):
        try:
            target.write_text("must not write")
        except OSError as error:
            assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS), (
                error
            )
        else:
            raise AssertionError("read-only write succeeded")
    assert protected.read_text() == "locked\n"
    assert not (root / "ro" / "new.txt").exists()
    return {"readonly": True}


def hidden(root):
    secret = root / "secret.txt"
    assert not secret.exists()
    try:
        secret.read_bytes()
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("hidden file was readable")
    assert "secret.txt" not in os.listdir(root)
    return {"hidden": True}


def parallel(root, index):
    started = time.time()
    path = root / f"process-{index}.txt"
    path.write_text(index)
    time.sleep(1)
    assert path.read_text() == index
    path.unlink()
    return {"index": index, "start": started, "end": time.time()}


def main():
    root, operation = Path(sys.argv[1]), sys.argv[2]
    if operation == "filesystem":
        result = filesystem(root)
    elif operation == "symlinks":
        result = symlinks(root, len(sys.argv) > 3 and sys.argv[3] == "scoped")
    elif operation == "threads":
        result = concurrent_files(root)
    elif operation == "readonly":
        result = readonly(root)
    elif operation == "hidden":
        result = hidden(root)
    elif operation == "parallel":
        result = parallel(root, sys.argv[3])
    elif operation == "seed":
        result = {"seed": (root / "seed.txt").read_text()}
    else:
        raise ValueError(operation)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
