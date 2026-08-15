# boardlink (Python)

Connect to climbing-board apps (Kilter, Tension, MoonBoard) and pull a normalized logbook. Native
implementation with no third-party board library, emitting the same `Ascent` shape as the TypeScript
`@boardlink/core` SDK.

```bash
pip install boardlink
```

```python
from boardlink import connect_kilter, connect_moonboard, BoardError

result = connect_kilter("you@example.com", "password")
for a in result.ascents:
    print(a.date, a.grade, a.v_grade, a.tries)

# Re-sync later without the password (store result.token, which is the refresh token):
result = connect_kilter(token=saved_refresh_token)

try:
    connect_moonboard("you@example.com", "wrong")
except BoardError as e:
    print(e.code)  # e.g. "bad-credentials"
```

Kilter uses the new kiltergrips.com backend (Keycloak auth + a REST logbook); Tension uses the Aurora
API; MoonBoard uses its own cookie/CSRF session. A password is used once to authenticate and is
never stored; persist only the returned token.

## Safety: untrusted board data

Climb names and comments are free text controlled by other users of the board, not by you. If you
feed them into an LLM prompt, a log line, or a shell, treat them as untrusted input. `boardlink`
ships small helpers (mirrored byte-for-byte in the TypeScript SDK) to make that easy:

```python
from boardlink import strip_raw, neutralize_for_prompt, UNTRUSTED_ASCENT_FIELDS

# Drop the raw backend passthrough before storing/forwarding ascents.
ascents = strip_raw(result.ascents)

# Wrap free text in fenced, control-char-stripped, NFKC-normalized delimiters before
# putting it in an LLM prompt.
safe = neutralize_for_prompt(ascent.comment or "")

# The fields that carry attacker-influenced text, if you want to sanitize your own way.
print(UNTRUSTED_ASCENT_FIELDS)  # ("climb_name", "comment", "raw")
```

See [`docs/security.md`](https://github.com/milwil-2/boardlink/blob/main/docs/security.md) for the
threat model and why these are contract-tested for byte-identical output across both languages.

## Develop

```bash
pip install -e ".[dev]"
pytest
```

The parsing and normalization logic is covered by tests that need no network. Only `requests` is
required at runtime.
