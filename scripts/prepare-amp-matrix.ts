/** Prints the approved matrix and bootstrap prompts; native create_thread launches them. */
export function prepareAmpMatrix(revision: string, parent: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a published full commit SHA");
  return ["sol", "astra"].flatMap((family) => ["low", "medium", "high"].flatMap((effort) =>
    ["original", "v21"].flatMap((variant) => Array.from({ length: 5 }, (_, i) => {
      const id = `${family}-${effort}-${variant}-${i + 1}`;
      const model = family === "sol" ? "openai/gpt-6.1-sol" : "openai/gpt-6-astra";
      return { id, model, effort, variant, repetition: i + 1, thread: null, status: "pending",
        prompt: `Run one eval session ${id} in this fresh app orb. You are only the harness operator. Do the work yourself; only the frozen plugin creates its configured main and planner. Do not inspect or change the app, clone evals, or read answer keys.
Run: curl -fsS --retry 3 https://raw.githubusercontent.com/andreimaxim/claude-maintain-rails-evals/${revision}/scripts/bootstrap-amp-run.sh -o .git/bootstrap.sh && bash .git/bootstrap.sh ${revision} ${variant} ${model} ${effort}
Load .amp/plugins/maintain-rails/index.ts with load_plugin. Call its registered run_eval tool once directly, without tool_search. Wait without retrying. On failure retain the outcome, do not change anything or rerun. Then run tar -czf .git/amp-results.tar.gz -C .git amp-evals. Do not print private exports. Send the tool result and archive path to ${parent}, and include them in your final response. Do not push or archive yourself.` };
    }))));
}

if (import.meta.main) {
  const [revision, parent] = process.argv.slice(2);
  if (!revision || !parent) throw new Error("Usage: prepare-amp-matrix.ts <published-revision> <parent-thread>");
  console.log(JSON.stringify({ revision, case: "rails", runs: prepareAmpMatrix(revision, parent) }, null, 2));
}
