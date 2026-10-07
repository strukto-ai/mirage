import pytest

from mirage.types import MountBackend
from mirage.workspace.workspace import kernel_mounts as km


class _Manager:
    seen: list = []
    mounts = None

    def setup(self, ops, prefix, mountpoint, session=None, backend=None):
        _Manager.seen = _Manager.mounts.exposed()
        if mountpoint == "/mnt/fail":
            raise OSError("no fuse")
        return mountpoint or f"/mnt{prefix}"

    def unmount(self) -> None:
        return None


class _Sessions:
    def get(self, session_id):
        return session_id


@pytest.fixture
def mounts(monkeypatch):
    monkeypatch.setattr(km, "FuseManager", _Manager)
    built = km.KernelMounts(None, _Sessions())
    _Manager.mounts = built
    return built


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


def test_an_exposure_is_held_during_setup_and_dropped_on_failure(mounts):
    # A mount added while setup runs must already see the exposure.
    mounts.add("/s3", "/mnt/one")
    assert _Manager.seen == [("/s3", MountBackend.FUSE)]
    with pytest.raises(OSError):
        mounts.add("/x", "/mnt/fail")
    assert mounts.exposed() == [("/s3", MountBackend.FUSE)]
    # A failed second expose of a live prefix keeps the live one's record.
    with pytest.raises(OSError):
        mounts.add("/s3", "/mnt/fail")
    assert mounts.exposed() == [("/s3", MountBackend.FUSE)]
    assert mounts.mountpoints == {"/s3": "/mnt/one"}
