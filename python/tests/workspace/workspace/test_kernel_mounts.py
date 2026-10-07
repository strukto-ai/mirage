import pytest

from mirage.types import MountBackend
from mirage.workspace.workspace import kernel_mounts as km


class _Manager:
    def setup(self, ops, prefix, mountpoint, session=None, backend=None):
        return mountpoint or f"/mnt{prefix}"

    def unmount(self) -> None:
        return None


class _Sessions:
    def get(self, session_id):
        return session_id


@pytest.fixture
def mounts(monkeypatch):
    monkeypatch.setattr(km, "FuseManager", _Manager)
    return km.KernelMounts(None, _Sessions())


def test_exposed_follows_add_remove_and_close(mounts):
    mounts.add("/s3", "/mnt/one", backend=MountBackend.FSKIT)
    mounts.add("/s3", "/mnt/two", session_id="agent")
    mounts.add("/a@b", "/mnt/three")
    assert sorted(mounts.exposed()) == [
        ("/a@b", MountBackend.FUSE),
        ("/s3", MountBackend.FSKIT),
        ("/s3", MountBackend.FUSE),
    ]
    mounts.remove("/s3", session_id="agent")
    assert sorted(mounts.exposed()) == [
        ("/a@b", MountBackend.FUSE),
        ("/s3", MountBackend.FSKIT),
    ]
    mounts.close()
    assert mounts.exposed() == []
