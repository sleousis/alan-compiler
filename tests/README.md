# Example tests

Each entry in `cases.json` names an example, its input file and whether it is built with `-O`.
The expected output of each case is in `expected/`.
It was recorded with the legacy pipeline (`./alan`, LLVM 23 and the assembly runtime).

The programs in `regress/` test fixed compiler bugs.
Their expected output (`regress/<name>.txt`) was written by hand from the language spec.
Each one is a case twice, with and without `-O`, and its entry names the file in `expected`.
Programs that must fail to compile are in `errors/`, checked by `run_errors.py`.

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

## Untested examples

- `prog11` is not a case. It answered "no" to every magic square tried, so its expected behaviour is unknown.
- `test2` is not a case. It calls a function with too few arguments and does not compile.
- `papariatest` is not a case. It was a scratch test with dead code after a `return`, and it calls an int function as a statement, which the spec does not allow. It is an error test in `errors/expected.json`.
- `test` is not a case. It reads the local `y` before setting it, so its output is undefined and can differ between platforms and runtimes.
