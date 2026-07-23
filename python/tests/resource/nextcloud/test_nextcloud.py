import pytest
from pydantic import ValidationError

from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource


def test_nextcloudconfig_defaults():
    c = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/")
    assert c.username is None
    assert c.password is None
    assert c.verify_ssl is True
    assert c.timeout == 30


def test_nextcloudconfig_immutable():
    c = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/")
    with pytest.raises(ValidationError):
        c.url = "https://other.example.com/"


def test_nextcloudconfig_with_credentials():
    c = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/",
        username="alice",
        password="secret",
        verify_ssl=False,
    )
    assert c.username == "alice"
    assert c.password == "secret"
    assert c.verify_ssl is False


def test_nextcloud_write_commands_tagged():
    from mirage.commands.builtin.nextcloud import COMMANDS
    write_names = {
        "cp", "csplit", "gunzip", "gzip", "iconv", "ln", "mkdir", "mktemp",
        "mv", "patch", "rm", "rmdir", "split", "tar", "tee", "touch", "unlink",
        "truncate", "unzip", "zip"
    }
    for fn in COMMANDS:
        for rc in fn._registered_commands:
            if rc.name in write_names:
                assert rc.write is True, f"{rc.name} should be write=True"
            else:
                assert rc.write is False, f"{rc.name} should be write=False"


def test_nextcloud_write_ops_tagged():
    from mirage.ops.nextcloud import OPS
    write_op_names = {
        "write", "unlink", "rmdir", "mkdir", "create", "truncate", "rename"
    }
    for ro in OPS:
        if ro.name in write_op_names:
            assert ro.write is True, f"op {ro.name} should be write=True"
        else:
            assert ro.write is False, f"op {ro.name} should be write=False"


def test_nextcloud_resource_registers_commands():
    config = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/")
    resource = NextcloudResource(config)
    command_names = {rc.name for rc in resource._commands}
    assert "ls" in command_names
    assert "cat" in command_names
    assert "grep" in command_names
    assert "find" in command_names
    assert "mkdir" in command_names
    assert "rm" in command_names


def test_nextcloud_resource_get_state():
    config = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/",
        username="alice",
        password="secret",
    )
    resource = NextcloudResource(config)
    state = resource.get_state()
    assert state["type"] == "nextcloud"
    assert state["needs_override"] is True
    assert state["config"]["password"] == "<REDACTED>"
    assert state["config"]["username"] == "alice"
    assert state["config"][
        "url"] == "https://cloud.example.com/remote.php/dav/files/user/"
