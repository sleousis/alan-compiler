#!/usr/bin/env python3
# Makes the fake release the installer tests serve: a tiny bundle for each
# platform in v2.0.0/ with its SHA256SUMS, and crafted archives in evil/
# whose entries try to leave the folder they are unpacked into.
# Run it again after changing it: python make.py
import gzip, hashlib, io, pathlib, tarfile, zipfile

HERE = pathlib.Path(__file__).resolve().parent
TAG = "v2.0.0"
PLATFORMS = ["windows-x64", "windows-arm64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]
STAMP = (2026, 1, 1, 0, 0, 0)


def zip_bytes(entries):
    """entries: (name, data or None for a folder, unix mode or None)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.external_attr = mode << 16
            z.writestr(info, data if data is not None else b"")
    return buf.getvalue()


def tar_bytes(entries):
    """entries: TarInfo with an optional payload."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for info, data in entries:
            info.mtime = 0
            if data is not None:
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
            else:
                t.addfile(info)
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as g:
        g.write(raw.getvalue())
    return out.getvalue()


def ti(name, kind=tarfile.REGTYPE, mode=0o644, link=""):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = mode
    info.linkname = link
    return info


def bundle(platform):
    windows = platform.startswith("windows-")
    alanc = b"fake alanc for " + platform.encode() + b"\n"
    version = (TAG + "\n").encode()
    if windows:
        return zip_bytes([
            ("alan/", None, None), ("alan/bin/", None, None),
            ("alan/bin/alanc.exe", alanc, None), ("alan/VERSION", version, None),
        ])
    return tar_bytes([
        (ti("alan", tarfile.DIRTYPE, 0o755), None), (ti("alan/bin", tarfile.DIRTYPE, 0o755), None),
        (ti("alan/bin/alanc", mode=0o755), alanc), (ti("alan/VERSION"), version),
    ])


def main():
    rel = HERE / TAG
    rel.mkdir(exist_ok=True)
    sums = []
    for p in PLATFORMS:
        name = f"alan-{TAG}-{p}." + ("zip" if p.startswith("windows-") else "tar.gz")
        data = bundle(p)
        (rel / name).write_bytes(data)
        sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
    (rel / "SHA256SUMS").write_bytes("".join(sums).encode())
    (HERE / "latest.json").write_bytes(b'{"tag_name": "v2.0.0", "name": "v2.0.0"}\n')

    evil = HERE / "evil"
    evil.mkdir(exist_ok=True)
    ok = b"fine\n"
    (evil / "dotdot.zip").write_bytes(zip_bytes([("alan/bin/alanc.exe", ok, None), ("alan/../../escaped.txt", ok, None)]))
    (evil / "absolute.zip").write_bytes(zip_bytes([("alan/bin/alanc.exe", ok, None), ("/tmp/escaped.txt", ok, None)]))
    (evil / "symlink.zip").write_bytes(zip_bytes([("alan/bin/alanc.exe", ok, None), ("alan/link", b"../../escaped", 0o120777)]))
    (evil / "dotdot.tar.gz").write_bytes(tar_bytes([(ti("alan/bin/alanc", mode=0o755), ok), (ti("alan/../../escaped.txt"), ok)]))
    (evil / "absolute.tar.gz").write_bytes(tar_bytes([(ti("alan/bin/alanc", mode=0o755), ok), (ti("/tmp/escaped.txt"), ok)]))
    (evil / "symlink.tar.gz").write_bytes(tar_bytes([
        (ti("alan/bin/alanc", mode=0o755), ok), (ti("alan/link", tarfile.SYMTYPE, 0o777, "../../escaped"), None),
        (ti("alan/link/escaped.txt"), ok),
    ]))
    # Each link stays inside on its own, but s leads to a shallower folder,
    # so u, read through s, would point two folders above the target.
    (evil / "chain.tar.gz").write_bytes(tar_bytes([
        (ti("alan/bin/alanc", mode=0o755), ok), (ti("alan/t", tarfile.DIRTYPE, 0o755), None),
        (ti("alan/a/b/s", tarfile.SYMTYPE, 0o777, "../../t"), None),
        (ti("alan/a/b/s/u", tarfile.SYMTYPE, 0o777, "../../escaped"), None),
        (ti("alan/a/b/s/u/escaped.txt"), ok),
    ]))
    # l1 points two folders up from a/b/c, to a. Read on paper from a,
    # b/c/l1/../../.. is dest/a and inside, but the kernel follows l1
    # first and lands two folders above dest.
    (evil / "updown.tar.gz").write_bytes(tar_bytes([
        (ti("alan/bin/alanc", mode=0o755), ok), (ti("alan/a/b/c", tarfile.DIRTYPE, 0o755), None),
        (ti("alan/a/b/c/l1", tarfile.SYMTYPE, 0o777, "../.."), None),
        (ti("alan/a/l2", tarfile.SYMTYPE, 0o777, "b/c/l1/../../.."), None),
    ]))
    (evil / "hardlink.tar.gz").write_bytes(tar_bytes([
        (ti("alan/bin/alanc", mode=0o755), ok), (ti("alan/passwd", tarfile.LNKTYPE, 0o644, "../../etc/passwd"), None),
    ]))


    # A link that stays inside is fine.
    (HERE / "inner-link.tar.gz").write_bytes(tar_bytes([
        (ti("alan/zig/zig", mode=0o755), ok), (ti("alan/bin/alanc", mode=0o755), ok),
        (ti("alan/bin/zig", tarfile.SYMTYPE, 0o777, "../zig/zig"), None),
    ]))


if __name__ == "__main__":
    main()
