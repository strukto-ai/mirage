import errno

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.types import MountMode, PathSpec
from mirage.utils.errors import ReadOnlyError
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.dispatcher.lineage import (BARE_PREFIX,
                                                 require_turf_writable,
                                                 turf_of)
from mirage.workspace.mount.mount import MountEntry


def _entry(prefix: str, mode: MountMode) -> MountEntry:
    return MountEntry(prefix, RAMVFS(), mode=mode)


def _path(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def test_turf_of_an_owned_path_is_its_mounts_prefix():
    # The prefix, because that is the key a profile writes a per-mount
    # mode under; the mount's own mode is not part of the rule.
    assert turf_of(_entry("/data/", MountMode.READ)) == "/data/"


def test_turf_of_an_unowned_path_is_the_root():
    assert turf_of(None) == BARE_PREFIX == "/"


def test_a_read_mount_still_takes_a_link():
    # A read-only MOUNT is a statement about a backend that cannot
    # write, and a symlink is namespace state that needs no write
    # capability from it -- which is why a link is pinned working above
    # postgres, mongodb, chroma and qdrant, all mounted read. Only a
    # session grant binds this plane.
    require_turf_writable(_entry("/data/", MountMode.WRITE), _path("/data/lk"))
    require_turf_writable(_entry("/ro/", MountMode.READ), _path("/ro/lk"))


def test_bare_turf_is_writable_without_a_session():
    require_turf_writable(None, _path("/toplink"))


@pytest.mark.asyncio
async def test_a_session_grant_narrows_an_owned_turf():
    # The grant is what binds: it says what this session may do, which
    # covers the namespace plane as well as the backend one, so a grant
    # that stops a file write at /extra stops the table write too.
    ws = Workspace({"/extra": (RAMVFS(), MountMode.WRITE)})
    entry = ws.namespace.try_mount_for("/extra/lk")
    sess = ws.create_session("agent", mounts={"/extra/": "read"})
    token = set_current_session(sess)
    try:
        with pytest.raises(ReadOnlyError):
            require_turf_writable(entry, _path("/extra/lk"))
    finally:
        reset_current_session(token)
    require_turf_writable(entry, _path("/extra/lk"))


@pytest.mark.asyncio
async def test_a_root_statement_governs_bare_turf():
    # "Above every mount" is governed by "/": a profile that caps the
    # root to read refuses the table write there, with no mount at /.
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)})
    sess = ws.create_session("agent", mounts={"/": "read"})
    token = set_current_session(sess)
    try:
        with pytest.raises(ReadOnlyError) as exc:
            require_turf_writable(None, _path("/toplink"))
        assert exc.value.errno == errno.EROFS
    finally:
        reset_current_session(token)
