# MoonBoard app API (reverse-engineered)

MoonBoard does not use the Aurora or Kilter backends. It runs a conventional ASP.NET web app at
**`moonboard.com`** with a cookie/CSRF session login and a paginated logbook endpoint.

> **Verification status: not live-verified.** The connector was built and tested against captured and
> mocked payloads; no MoonBoard account was available at test time. Treat the shapes below as
> confirmed against those fixtures but not yet exercised end to end against the live site. This is
> called out honestly rather than presented as fully proven.

---

## 1. Auth - cookie / CSRF session

MoonBoard uses a standard anti-forgery-token login, not a JSON token API.

1. `GET /account/login` - load the login page and scrape two hidden form values from the HTML:
   - `__RequestVerificationToken` (the CSRF token; required)
   - `form_key` (may be empty)
2. `POST /Account/login` - form-encoded body:
   ```
   Login.Username=<username or email>
   Login.Password=<password>
   __RequestVerificationToken=<token from step 1>
   form_key=<form_key from step 1>
   ```
   Sent with `Referer: https://moonboard.com/account/login` and redirects disabled.

Success is inferred from either a `3xx` redirect **or** the presence of an auth cookie (a cookie whose
name matches `auth`, `aspnet`, or `moon`). If neither is present, it is treated as bad credentials.
The "token" boardlink returns for re-syncs is the serialized cookie jar; the password is used once and
never stored.

---

## 2. Logbook - paginated, per board setup

`POST /Logbook/GetLogbook`

Headers: `X-Requested-With: XMLHttpRequest`, `Content-Type: application/x-www-form-urlencoded`.

Body (form-encoded), one board setup at a time:
```
sort=
page=<n>
pageSize=40
group=
filter=setupId~eq~'<setupId>'
```

Board setups are queried by id:

| Setup | setupId |
|---|---|
| MoonBoard 2016 | 1 |
| MoonBoard Masters 2017 | 15 |
| MoonBoard Masters 2019 | 17 |
| MoonBoard 2020 | 19 |
| MoonBoard 2024 | 21 |

The connector loops over each setup and pages through results (`page` 1 upward, `pageSize` 40),
stopping when `Total <= pageSize * page` or a page comes back empty. A `401` or `403` means the
session expired.

Some logbook rows arrive without an embedded `Problem` object. For those, the detail is fetched with
`POST /Logbook/GetLogbookEntries/{Id}` and the returned `Data` rows are used instead.

---

## 3. Ascent fields and normalization

Each entry provides:
```
DateClimbedAsString ("12 Aug 2024"), NumberOfTries, Comment,
Problem { Name, Grade, UserGrade, IsBenchmark }
```

Normalization rules boardlink applies:
- **Date** is parsed from the "12 Aug 2024" form to ISO `YYYY-MM-DD`; unparseable dates are skipped.
- **Tries** map from a label: `Flashed` = 1, `2nd try` = 2, `3rd try` = 3, `more than 3 tries` = 4.
  `Project` is not a send and is skipped.
- **Grade** comes directly from `Problem.Grade` (MoonBoard supplies a real font grade, so no
  difficulty table is needed). `UserGrade` falls back to `Grade`. The V-grade is parsed from the font
  grade.
- **Angle** is recorded as 40 (the connector uses a fixed angle; MoonBoard boards ship at fixed
  angles rather than a settable one).
- `IsBenchmark` and `Comment` map through; the full entry is kept in `raw`.

---

## Resolved / remaining

- **Auth - implemented, not live-verified.** CSRF-token login; success inferred from a redirect or an
  auth cookie.
- **Read path - implemented, not live-verified.** Per-setup paginated `POST /Logbook/GetLogbook`,
  with a per-entry detail fallback.
- **Grades - straightforward.** MoonBoard returns real font grades directly; no difficulty mapping.
- **Still open:** an end-to-end run against a live MoonBoard account to confirm the login success
  signal, pagination stop condition, and the exact entry field names against current production.
