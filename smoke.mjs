// Standalone smoke test of the agent driver — no VS Code needed.
// Relies on ambient Claude Code auth (~/.claude) or ANTHROPIC_API_KEY.
import { askStackOverflow } from "./out/agent.js";

const ctx = {
  question: "How do I debounce a function in TypeScript?",
  languageId: "typescript",
  fileName: "src/util.ts",
  selection: "",
  surrounding: "export function handleResize() {\n  // recompute layout\n}",
  workspaceRoot: process.cwd(),
};

console.log("Running agent (this hits the model + tools)…\n");
const thread = await askStackOverflow(ctx, {
  model: "claude-sonnet-4-6",
  answerCount: 3,
  cwd: process.cwd(),
  // Force the user's installed Claude Code, simulating a published install
  // where the SDK's bundled binary is NOT present.
  claudeCodePath: process.env.HOME + "/.local/bin/claude",
  onProgress: (e) => console.log(`  · [${e.kind}] ${e.label}`),
});

console.log("\n=== TITLE ===\n" + thread.title);
console.log("\n=== TAGS ===\n" + thread.tags.join(", "));
console.log(`\n=== ${thread.answers.length} ANSWERS ===`);
for (const a of thread.answers) {
  console.log(`\n[${a.accepted ? "✓ ACCEPTED" : " "}] ${a.votes} votes — ${a.author}`);
  console.log(a.bodyMarkdown.split("\n").map((l) => "    " + l).join("\n"));
}
