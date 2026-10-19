import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAmpMatrix } from "./prepare-amp-matrix.ts";

test("matrix gives every model, effort and prompt five independent orb sessions", () => {
  const matrix = prepareAmpMatrix("a".repeat(40), "T-parent");
  assert.equal(matrix.length, 60);
  assert.equal(new Set(matrix.map((run) => run.id)).size, 60);
  for (const model of ["openai/gpt-6.1-sol", "openai/gpt-6-astra"]) {
    for (const effort of ["low", "medium", "high"]) for (const variant of ["original", "v21"]) {
      const group = matrix.filter((run) => run.model === model && run.effort === effort && run.variant === variant);
      assert.deepEqual(group.map((run) => run.repetition), [1, 2, 3, 4, 5]);
      for (const run of group) assert.ok(run.prompt.includes(`${variant} ${model} ${effort}`));
    }
  }
  assert.throws(() => prepareAmpMatrix("main", "T-parent"), /commit/);
});
