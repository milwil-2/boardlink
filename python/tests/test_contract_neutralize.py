"""Cross-language contract for ``neutralize_for_prompt``.

The vectors in ``<repo>/fixtures/neutralize.json`` are shared verbatim with the TypeScript suite
(``packages/core/src/__tests__/contract.neutralize.test.ts``), so both implementations are held to
byte-identical output for the same input. This is what backs the "byte-identical" claim in
``docs/security.md`` and guards against parity drift.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from boardlink import neutralize_for_prompt

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "neutralize.json"
VECTORS = json.loads(FIXTURE.read_text(encoding="utf-8"))["vectors"]


def test_has_vectors() -> None:
    assert len(VECTORS) > 0


@pytest.mark.parametrize("vec", VECTORS, ids=[v["name"] for v in VECTORS])
def test_neutralize_contract(vec) -> None:
    max_length = vec.get("maxLength")
    out = neutralize_for_prompt(vec["input"], max_length) if max_length is not None else neutralize_for_prompt(vec["input"])
    assert out == vec["expected"]
