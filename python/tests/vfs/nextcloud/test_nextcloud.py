from mirage.commands.builtin.backends import commands_for
from mirage.vfs.nextcloud import NextcloudConfig, NextcloudVFS


def test_nextcloud_write_commands_tagged():
    from mirage.commands.builtin.nextcloud import COMMANDS

    write_names = {
        "cp",
        "csplit",
        "gunzip",
        "gzip",
        "iconv",
        "ln",
        "mkdir",
        "mktemp",
        "mv",
        "patch",
        "rm",
        "rmdir",
        "split",
        "tar",
        "tee",
        "touch",
        "unlink",
        "truncate",
        "unzip",
        "zip",
    }
    for fn in COMMANDS:
        for rc in fn._registered_commands:
            if rc.name in write_names:
                assert rc.write is True, f"{rc.name} should be write=True"
            else:
                assert rc.write is False, f"{rc.name} should be write=False"


def test_nextcloud_vfs_registers_commands():
    config = NextcloudConfig(
        url="https://cloud.example.com/remote.php/dav/files/user/"
    )
    vfs = NextcloudVFS(config)
    command_names = {rc.name for rc in commands_for(vfs)}
    assert "ls" in command_names
    assert "cat" in command_names
    assert "grep" in command_names
    assert "find" in command_names
    assert "mkdir" in command_names
    assert "rm" in command_names
