#!/usr/bin/env python3
"""Writes the firmware manifest Firestore reads at firmware/current.

Kept separate from release-firmware.sh because gcloud's firestore document
commands are awkward for nested writes, and the REST API is unambiguous.
"""
import json
import subprocess
import sys

PROJECT = "watima-7d274"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def token() -> str:
    return subprocess.check_output(
        ["gcloud", "auth", "print-access-token"], text=True
    ).strip()


def patch(fields: dict, mask: list[str]) -> None:
    # Shells out to curl rather than using urllib: the python.org Python on
    # macOS ships without a usable CA bundle, so urllib fails TLS verification
    # against googleapis.com unless SSL_CERT_FILE happens to be exported.
    # curl uses the system trust store and just works.
    qs = "&".join(f"updateMask.fieldPaths={m}" for m in mask)
    out = subprocess.run(
        [
            "curl", "-sS", "-X", "PATCH", f"{BASE}/firmware/current?{qs}",
            "-H", f"Authorization: Bearer {token()}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps({"fields": fields}),
            "-w", "\n%{http_code}",
        ],
        capture_output=True, text=True, check=True,
    )
    code = out.stdout.strip().splitlines()[-1]
    if code != "200":
        raise SystemExit(f"manifest write failed (HTTP {code}):\n{out.stdout}")


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "pause":
        patch({"paused": {"booleanValue": True}}, ["paused"])
        return
    if cmd == "publish":
        version, size, sha, path, pct = sys.argv[2:7]
        patch(
            {
                "version": {"stringValue": version},
                "size": {"integerValue": str(size)},
                "sha256": {"stringValue": sha},
                "storagePath": {"stringValue": path},
                "rolloutPercent": {"integerValue": str(pct)},
                "paused": {"booleanValue": False},
            },
            ["version", "size", "sha256", "storagePath", "rolloutPercent", "paused"],
        )
        return
    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
