#!/usr/bin/env python3
"""Checks how alanc treats its command line, unreadable sources and Ctrl-C."""
import argparse, os, pathlib, re, signal, subprocess, sys, tempfile, threading, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
WINDOWS = os.name == "nt"
failed = 0


def report(ok: bool, what: str, detail: str = "") -> None:
    global failed
    if ok:
        print("PASS", what)
    else:
        failed += 1
        print("FAIL", what)
        if detail:
            print(detail)


def alanc(exe: str, *args: str, env=None):
    r = subprocess.run([exe, *args], stdin=subprocess.DEVNULL, capture_output=True,
                       timeout=120, env=env)
    return r.returncode, r.stderr.decode("utf-8", "replace")


def expect_usage(exe: str, *args: str) -> None:
    code, err = alanc(exe, *args)
    report(code == 2 and err.startswith("usage: alanc"),
           "usage for alanc " + " ".join(args), f"exit {code}, stderr: {err!r}")


def expect_cannot_open(exe: str, args, path: str, reason: str) -> None:
    code, err = alanc(exe, *args)
    want = re.compile(r"^alanc: error: cannot open " + re.escape(path) + ": " + reason
                      + r"\s*$", re.IGNORECASE)
    report(code == 1 and want.match(err) is not None,
           "cannot open for alanc " + " ".join(args), f"exit {code}, stderr: {err!r}")


def kill_all(p: subprocess.Popen) -> None:
    """Ends alanc and the program it runs."""
    if WINDOWS:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       capture_output=True)
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    p.wait()


def read_line(p: subprocess.Popen, seconds: float) -> bytes:
    """The first line the program prints, or b"" when none comes in time."""
    box = []
    t = threading.Thread(target=lambda: box.append(p.stdout.readline()), daemon=True)
    t.start()
    t.join(seconds)
    return box[0] if box else b""


def check_interrupt(exe: str, work: pathlib.Path, group: bool) -> None:
    """Ctrl-C while `alanc run` waits for its program must end both and
    leave no temporary file behind. With group, the signal goes to alanc and
    the program as from a terminal, otherwise to alanc alone, which passes
    it on."""
    what = "Ctrl-C during alanc run" + ("" if group else ", sent to alanc alone")
    tmp = work / ("tmp-group" if group else "tmp-alanc")
    tmp.mkdir()
    env = dict(os.environ, TMPDIR=str(tmp), TMP=str(tmp), TEMP=str(tmp))
    src = ROOT / "tests/regress/rt-wait.alan"
    kw = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS \
        else {"start_new_session": True}
    p = subprocess.Popen([exe, "run", str(src)], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, **kw)
    # The program prints a line and then waits for input.
    line = read_line(p, 300)
    if line.strip() != b"waiting":
        kill_all(p)
        report(False, what, f"program printed {line!r}")
        return
    if WINDOWS:
        os.kill(p.pid, signal.CTRL_BREAK_EVENT)
    elif group:
        os.killpg(p.pid, signal.SIGINT)
    else:
        os.kill(p.pid, signal.SIGINT)
    try:
        p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        kill_all(p)
        report(False, what, "alanc did not end")
        return
    # Removing a file on Windows can lag behind the handle being closed.
    for _ in range(50):
        left = [f.name for f in tmp.iterdir()]
        if not left:
            break
        time.sleep(0.1)
    err = p.stderr.read().decode("utf-8", "replace")
    report(p.returncode == 130 and not left, what,
           f"exit {p.returncode}, files left: {left}, stderr: {err!r}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alanc", required=True)
    exe = ap.parse_args().alanc
    hello = str(ROOT / "Examples/HelloWorld.alan")

    expect_usage(exe)
    expect_usage(exe, "--help")
    expect_usage(exe, "-h")
    expect_usage(exe, "check")
    expect_usage(exe, "check", hello, hello)
    expect_usage(exe, "check", "-O", hello)
    expect_usage(exe, "run")
    expect_usage(exe, "build")

    with tempfile.TemporaryDirectory() as d:
        work = pathlib.Path(d)
        folder = work / "folder.alan"
        folder.mkdir()
        for args in (["check"], ["build"], ["run"], []):
            expect_cannot_open(exe, args + [str(folder)], str(folder), "is a directory")
        missing = str(work / "missing.alan")
        expect_cannot_open(exe, ["check", missing], missing, "no such file or directory")

        # root reads any file, so the test needs another user.
        if not WINDOWS and os.geteuid() != 0:
            locked = work / "locked.alan"
            locked.write_text("main () : proc { }\n")
            locked.chmod(0)
            expect_cannot_open(exe, ["check", str(locked)], str(locked), "permission denied")

        check_interrupt(exe, work, group=True)
        # Windows cannot send Ctrl-C to one process of a group.
        if not WINDOWS:
            check_interrupt(exe, work, group=False)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
