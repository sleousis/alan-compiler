# Example tests

Each entry in `cases.json` names an example, its input file and whether it is built with `-O`.
The expected output of each case is in `expected/`.
It was recorded with the legacy pipeline (`./alan`, LLVM 23 and the assembly runtime).

Run the cases against a compiler:

```
python tests/run_examples.py --alanc <path-to-alanc>
python tests/run_examples.py --alanc <path-to-alanc> --only HanoiTowers
```

Record the expected output again (in WSL):

```
bash tests/record_legacy.sh
```

The legacy runtime reads input with raw `read()` calls.
The recording script feeds input one line at a time with a short pause for that reason.

## Regression cases

The cases in `regress/` check bugs that were fixed.
Their expected output is written by hand, and the recording script skips them.
The `rt-` cases cover the runtime library.
`rt-wait.alan` is not a case. `run_cli.py` uses it.

## Command line

`run_cli.py` checks the usage message, sources that cannot be opened, and that Ctrl-C during `alanc run` leaves no temporary files:

```
python tests/run_cli.py --alanc <path-to-alanc>
```

## Runtime library

`run_rt_test.py` builds `runtime/test/rt_test.c` with the runtime and zig (`ALAN_ZIG` or `--zig`) and compares its output with `rt_test_expected.txt`:

```
python tests/run_rt_test.py
```

## Untested examples

- `prog11` is not a case. It answered "no" to every magic square tried, so its expected behaviour is unknown.
- `test2` is not a case. It calls a function with too few arguments and does not compile.
- `test` is not a case. It reads the local `y` before setting it, so its output is undefined and can differ between platforms and runtimes.
