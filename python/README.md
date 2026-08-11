# boardlink (Python)

Connect to climbing-board apps (Kilter, Tension, MoonBoard) and pull a normalized logbook. Native
implementation — no third-party board library — emitting the same `Ascent` shape as the TypeScript
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

Kilter uses the new kiltergrips.com backend (Keycloak auth + PowerSync); Tension uses the Aurora
API; MoonBoard uses its own cookie/CSRF session. A password is used once to authenticate and is
never stored — persist only the returned token.

## Develop

```bash
pip install -e ".[dev]"
pytest
```

The parsing and normalization logic is covered by tests that need no network. Only `requests` is
required at runtime.
