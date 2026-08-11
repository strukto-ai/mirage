import asyncio
import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveConfig
from mirage.resource.onedrive import OneDriveResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot.drift import ContentDriftError, check_drift

_ITEM = re.compile(r".*/root:/a\.txt(\?.*)?$")


def _mount_for():
    backend = OneDriveResource(OneDriveConfig(access_token="tok"))
    ws = Workspace({"/od": (backend, MountMode.WRITE)}, mode=MountMode.WRITE)
    return ws._registry.mount_for


def test_drift_raises_when_live_ctag_differs():
    with aioresponses() as m:
        m.get(_ITEM,
              payload={
                  "name": "a.txt",
                  "size": 3,
                  "cTag": "live-ctag",
                  "file": {}
              })
        with pytest.raises(ContentDriftError) as exc:
            asyncio.run(check_drift(_mount_for(), "/od/a.txt",
                                    "snapshot-ctag"))
    assert exc.value.path == "/od/a.txt"
    assert exc.value.live_fingerprint == "live-ctag"


def test_no_drift_when_ctag_matches():
    with aioresponses() as m:
        m.get(_ITEM,
              payload={
                  "name": "a.txt",
                  "size": 3,
                  "cTag": "same-ctag",
                  "file": {}
              })
        asyncio.run(check_drift(_mount_for(), "/od/a.txt", "same-ctag"))


def test_drift_raises_when_file_missing():
    with aioresponses() as m:
        m.get(_ITEM,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        with pytest.raises(ContentDriftError):
            asyncio.run(check_drift(_mount_for(), "/od/a.txt",
                                    "snapshot-ctag"))
