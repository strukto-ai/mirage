from mirage.commands.builtin.onedrive import COMMANDS

READ_ONLY_COMMANDS = {
    "cat",
    "find",
    "grep",
    "head",
    "jq",
    "ls",
    "rg",
    "sort",
    "stat",
    "tail",
    "tree",
    "wc",
}

WRITE_COMMANDS = {
    "cp",
    "mkdir",
    "mv",
    "rm",
    "touch",
}


def registered_onedrive_commands():
    return [
        registered for command in COMMANDS
        for registered in command._registered_commands
    ]


def test_core_onedrive_commands_registered():
    registered = registered_onedrive_commands()
    names = {command.name for command in registered}

    assert READ_ONLY_COMMANDS <= names
    assert WRITE_COMMANDS <= names


def test_onedrive_command_resources_and_write_flags():
    for command in registered_onedrive_commands():
        assert command.resource == "onedrive"
        if command.name in WRITE_COMMANDS:
            assert command.write
        if command.name in READ_ONLY_COMMANDS:
            assert not command.write
