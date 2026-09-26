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

## Untested examples

- `prog11` is not a case. It answered "no" to every magic square tried, so its expected behaviour is unknown.
- `test2` is not a case. It calls a function with too few arguments and does not compile.
- `test` reads `y` without setting it first. Its recorded output ("nikhsame") assumes `y` is not 5.
