import pytest

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.dav import dav_url, uploads_url
from mirage.types import PathSpec
from mirage.vfs.nextcloud import NextcloudConfig
from tests.core.nextcloud.conftest import ROOT


@pytest.mark.parametrize(
    ("path", "folder", "url"),
    [
        ("/a b/c#d.txt", False, f"{ROOT}/a%20b/c%23d.txt"),
        ("/docs", True, f"{ROOT}/docs/"),
        ("/", True, f"{ROOT}/"),
    ],
)
def test_a_path_is_percent_encoded_under_the_endpoint(
    make_acc, path, folder, url
):
    assert dav_url(make_acc(), PathSpec.from_str_path(path), folder) == url


@pytest.mark.parametrize(
    ("url", "uploads"),
    [
        (f"{ROOT}/", "https://cloud.example.com/remote.php/dav/uploads/user"),
        (
            "https://cloud.example.com/nc/remote.php/webdav/docs",
            "https://cloud.example.com/nc/remote.php/dav/uploads/a%40b",
        ),
        ("https://dav.example.com/files/", None),
    ],
)
def test_uploads_are_the_users_collection(url, uploads):
    config = NextcloudConfig(url=url, username="a@b")
    assert uploads_url(NextcloudAccessor(config)) == uploads
