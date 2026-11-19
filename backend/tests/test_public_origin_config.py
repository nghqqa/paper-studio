"""Public plugin origin is explicit, independent of server-to-server routing."""

import runpy
from pathlib import Path

import pytest

CONFIG = Path(__file__).resolve().parents[1] / "app" / "config.py"


@pytest.mark.parametrize("public_origin", [None, "", "   "])
def test_old_https_deployments_keep_the_existing_origin(monkeypatch, public_origin):
    monkeypatch.setenv("PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL", "https://paper.example.com/")
    if public_origin is None:
        monkeypatch.delenv("PATENT_STUDIO_PUBLIC_ORIGIN", raising=False)
    else:
        monkeypatch.setenv("PATENT_STUDIO_PUBLIC_ORIGIN", public_origin)
    settings = runpy.run_path(str(CONFIG))
    assert settings["PUBLIC_ORIGIN"] == "https://paper.example.com"


def test_public_origin_overrides_only_browser_routing(monkeypatch):
    monkeypatch.setenv("PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL", "http://app:8000")
    monkeypatch.setenv("PATENT_STUDIO_PUBLIC_ORIGIN", " https://paper.example.com:8443/ ")
    settings = runpy.run_path(str(CONFIG))
    assert settings["PUBLIC_ORIGIN"] == "https://paper.example.com:8443"
    assert settings["ONLYOFFICE_PUBLIC_URL"] == "http://app:8000"


@pytest.mark.parametrize("value", ["paper.example.com", "ftp://paper.example.com",
                                  "https://user:secret@paper.example.com",
                                  "https://paper.example.com/api", "https://paper.example.com?key=x",
                                  "https://paper.example.com#fragment", "https://paper.example.com:invalid"])
def test_invalid_explicit_origins_fail_with_a_configuration_error(monkeypatch, value):
    monkeypatch.setenv("PATENT_STUDIO_PUBLIC_ORIGIN", value)
    with pytest.raises(ValueError, match="PATENT_STUDIO_PUBLIC_ORIGIN"):
        runpy.run_path(str(CONFIG))
