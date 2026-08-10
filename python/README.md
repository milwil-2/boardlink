# boardlink (Python)

Connect to climbing-board apps (Kilter, Tension, MoonBoard) and pull a normalized logbook. Wraps the
community [`boardlib`](https://github.com/lemeryfertitta/BoardLib) package and normalizes every entry
into a board-agnostic `Ascent` — the same contract as the TypeScript `@boardlink/core` SDK.

```bash
pip install boardlink
```

```python
from boardlink import connect_kilter, connect_moonboard, BoardError

result = connect_kilter("you@example.com", "password")
for a in result.ascents:
    print(a.date, a.grade, a.v_grade, a.tries)

try:
    connect_moonboard("you@example.com", "wrong")
except BoardError as e:
    print(e.code)  # e.g. "bad-credentials"
```

## Notes

- A password is used once to authenticate through `boardlib`; boardlink stores nothing.
- `boardlib` re-authenticates per call, so `ConnectResult.token` is empty for the Python path (unlike
  the TS SDK, which returns a reusable session token).
- All `boardlib`-specific calls live in `boardlink/_backend.py` — the single place to adjust if your
  installed `boardlib` version exposes different function names. The normalization (`normalize_entry`)
  and grade parsing are pure and covered by tests that don't require `boardlib` or a network.

## Develop

```bash
pip install -e ".[dev]"
pytest
```
