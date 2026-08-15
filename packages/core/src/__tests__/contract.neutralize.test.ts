// Cross-language contract for neutralizeForPrompt. The vectors in <repo>/fixtures/neutralize.json are
// shared verbatim with python/tests/test_contract_neutralize.py, so both implementations are held to
// byte-identical output for the same input (this is what makes the "byte-identical" claim in
// docs/security.md true, and catches parity drift like the earlier DEL / UTF-16-truncation breaks).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { neutralizeForPrompt } from "../safety.js";

interface Vec {
  name: string;
  input: string;
  expected: string;
  maxLength?: number;
}

const path = fileURLToPath(new URL("../../../../fixtures/neutralize.json", import.meta.url));
const { vectors } = JSON.parse(readFileSync(path, "utf8")) as { vectors: Vec[] };

describe("neutralizeForPrompt contract vectors", () => {
  it("has vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });
  for (const v of vectors) {
    it(v.name, () => {
      const out =
        v.maxLength != null
          ? neutralizeForPrompt(v.input, { maxLength: v.maxLength })
          : neutralizeForPrompt(v.input);
      expect(out).toBe(v.expected);
    });
  }
});
