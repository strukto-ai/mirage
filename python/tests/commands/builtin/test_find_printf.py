from mirage.commands.builtin.find_printf import (expand_printf,
                                                 printf_needs_stat)
from mirage.commands.builtin.utils.identity import Identity
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _spec(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(resource_path=virtual.strip("/"),
                    virtual=virtual,
                    directory=virtual,
                    resolved=True,
                    raw_path=raw if raw is not None else virtual)


def _stat(size: int = 6,
          file_type: ContentType | FileType = ContentType.TEXT) -> FileStat:
    if isinstance(file_type, FileType):
        return FileStat(name="a",
                        size=size,
                        type=file_type,
                        modified="2026-08-16T13:45:30+00:00")
    return FileStat(name="a",
                    size=size,
                    type=FileType.FILE,
                    content=file_type,
                    modified="2026-08-16T13:45:30+00:00")


def test_printf_needs_stat():
    assert printf_needs_stat("%s\n")
    assert printf_needs_stat("%TY\n")
    assert printf_needs_stat("%u %g\n")
    assert not printf_needs_stat("%p %f %h %P %d\n")
    assert not printf_needs_stat("100%%score\n")


def test_expand_path_directives():
    warnings: list[str] = []
    search = _spec("/data")
    row = "/data/sub/b.txt"
    assert expand_printf(
        "%p|%P|%f|%h|%d\n", row, search, None,
        warnings) == "/data/sub/b.txt|sub/b.txt|b.txt|/data/sub|2\n"
    assert warnings == []


def test_expand_stat_directives():
    warnings: list[str] = []
    search = _spec("/data")
    out = expand_printf("%s %y %m %M\n", "/data/a.txt", search, _stat(),
                        warnings)
    assert out == "6 f 644 -rw-r--r--\n"
    dir_out = expand_printf("%y %m\n", "/data/sub", search,
                            _stat(0, FileType.DIRECTORY), warnings)
    assert dir_out == "d 755\n"


def test_expand_owner_directives():
    warnings: list[str] = []
    search = _spec("/data")
    identity = Identity(user="alice", profile="admin")
    # No uid/gid on the entry: the owner is the workspace user and the
    # group the session's profile, the rule ls -l draws its columns by.
    assert expand_printf("%u %U %g %G\n",
                         "/data/a.txt",
                         search,
                         _stat(),
                         warnings,
                         identity=identity) == "alice alice admin admin\n"
    # A reported owner wins; `-` when nothing names one.
    owned = _stat().model_copy(update={"uid": 501, "gid": "staff"})
    assert expand_printf("%u %g\n",
                         "/data/a.txt",
                         search,
                         owned,
                         warnings,
                         identity=identity) == "501 staff\n"
    assert expand_printf("%u %g\n", "/data/a.txt", search, _stat(),
                         warnings) == "- -\n"
    assert warnings == []


def test_expand_reported_mode_over_default():
    warnings: list[str] = []
    search = _spec("/data")
    st = FileStat(name="a",
                  size=6,
                  type=FileType.FILE,
                  content=ContentType.TEXT,
                  mode=0o600)
    assert expand_printf("%m %M\n", "/data/a.txt", search, st,
                         warnings) == "600 -rw-------\n"
    d = FileStat(name="sub", size=0, type=FileType.DIRECTORY, mode=0o700)
    assert expand_printf("%m %M\n", "/data/sub", search, d,
                         warnings) == "700 drwx------\n"


def test_expand_capital_y_reports_target_kind():
    warnings: list[str] = []
    search = _spec("/data")
    link = _stat(5, FileType.SYMLINK)
    assert expand_printf("%y %Y\n", "/data/lnk", search, link, warnings,
                         _stat(0, FileType.DIRECTORY)) == "l d\n"
    assert expand_printf("%y %Y\n", "/data/lnk", search, link, warnings,
                         None) == "l N\n"
    assert expand_printf("%y %Y\n", "/data/a.txt", search, _stat(),
                         warnings) == "f f\n"


def test_expand_time_directives():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("%TY-%Tm-%Td\n", "/data/a.txt", search, _stat(),
                         warnings) == "2026-08-16\n"
    epoch = expand_printf("%T@\n", "/data/a.txt", search, _stat(), warnings)
    assert epoch == "1786887930.0000000000\n"
    assert len(epoch.strip().split(".")[1]) == 10


def test_expand_escapes_and_unknown():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("A\\tB\\n", "/data/a.txt", search, None,
                         warnings) == "A\tB\n"
    assert expand_printf("%Q\n", "/data/a.txt", search, None,
                         warnings) == "%Q\n"
    assert warnings == ["find: warning: unrecognized format directive '%Q'"]
    expand_printf("%Q %Q\n", "/data/a.txt", search, None, warnings)
    assert len(warnings) == 1


def test_expand_root_row():
    warnings: list[str] = []
    search = _spec("/data")
    assert expand_printf("%P|%d|%f\n", "/data", search, None,
                         warnings) == "|0|data\n"
