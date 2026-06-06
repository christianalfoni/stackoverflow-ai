import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// The Agent SDK ships as ESM only; load it via dynamic import so this
// CommonJS extension (required by the VS Code extension host) can use it.
// `module: "Node16"` preserves this import() instead of downleveling to require().
async function loadQuery() {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  return mod.query;
}

/**
 * Locate the user's installed Claude Code executable. We ship only the SDK's
 * JS (not its 225 MB per-platform binary), so we point the SDK at the `claude`
 * the user already has from Claude Code. GUI-launched editors don't inherit the
 * shell PATH, so we check known install locations too.
 */
export function findClaudeExecutable(override?: string): string | undefined {
  if (override && existsSync(override)) {
    return override;
  }
  // Try PATH (works when the editor was launched from a shell).
  try {
    const cmd = process.platform === "win32" ? "where claude" : "command -v claude";
    const found = execSync(cmd, { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (found && existsSync(found)) {
      return found;
    }
  } catch {
    // not on PATH — fall through to known locations
  }
  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [
          join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
          join(home, ".local", "bin", "claude.exe"),
        ]
      : [
          join(home, ".local", "bin", "claude"),
          join(home, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ];
  return candidates.find((p) => existsSync(p));
}

// Derive the options type from the dynamically-imported query function,
// avoiding a static type-only import from the ESM module.
type Options = NonNullable<Parameters<Awaited<ReturnType<typeof loadQuery>>>[0]["options"]>;

/** One answer in the Stack Overflow-style thread. */
export interface SOAnswer {
  /** Humorous spinoff of a real ecosystem figure's name, e.g. "dan_abramnope". */
  author: string;
  /** Flavor reputation number, purely cosmetic. */
  reputation: number;
  /** Net vote count. The accepted answer usually has the most. */
  votes: number;
  /** Exactly one answer in the array should be accepted. */
  accepted: boolean;
  /** The answer body in Markdown (prose + fenced code blocks). Keep it tight. */
  bodyMarkdown: string;
  /** URLs of web pages actually fetched to back this answer. Optional. */
  sources?: string[];
}

/** The full thread rendered into the webview. */
export interface SOThread {
  /** Concise question title, the way a good SO title reads. */
  title: string;
  /** The fleshed-out question body in Markdown. */
  questionMarkdown: string;
  /** Short technology tags, e.g. ["typescript", "vscode-api"]. */
  tags: string[];
  answers: SOAnswer[];
}

/** Lightweight context captured when the user asked. No file contents — the
 *  agent inspects the project's dependencies/versions itself, on demand. */
export interface AskContext {
  question: string;
  languageId?: string;
  fileName?: string;
  workspaceRoot?: string;
}

/** A progress event surfaced to the webview while the agent researches. */
export interface ProgressEvent {
  kind: "tool" | "final" | "status";
  label: string;
}

const SYSTEM_PROMPT = `You are the engine behind "Stack Overflow AI", a tool that answers a developer's
coding question in the exact format and spirit of a Stack Overflow thread.

You are the opposite of a chatbot: be TERSE. A good answer is a direct solution, a
minimal code block, and a sentence or two of explanation. No preamble, no
pleasantries, no restating the problem, no closing summary.

THE GOLDEN RULE — NEVER REFERENCE THE USER'S CODE:
The code and context you receive exist only to help you work out the general
technical question to answer. The thread you produce must read like a real Stack
Overflow page written by and for strangers who have never seen this codebase. You
are not doing a code review and you are not fixing their file.

- Never diagnose or correct their actual code, and never mention their file names,
  variable names, function names, types, or project structure anywhere in the thread.
- Distill the underlying general problem and answer that, reconstructed as a
  minimal, self-contained, generic example.
- You MAY tailor to the dependency versions they actually have installed — that's
  just being accurate, like any good SO answer ("In React 18…"). Targeting the right
  version is fine; referencing their code, files, or project layout is not.
- Second person is fine the way real SO answers use it, as long as it addresses the
  general question rather than their specific code.

If an answer would not help a stranger who Googled this question, it's too specific.

WORKFLOW:
1. Give VERSION-ACCURATE help: check which dependencies the project uses and at what
   versions (read its manifest and lock file, e.g. package.json + the lock file, or
   the equivalent for the stack), then consult documentation — local or web — for
   those exact versions. Ground every answer in what you verified; never guess an API
   signature. You have read-only file tools (Read, Grep, Glob) and web tools
   (WebSearch, WebFetch) but NO shell — open package.json and the lock file with Read,
   don't try to cat or run them. Do NOT read or rely on the user's own source files —
   only their dependency/version/documentation information.
2. Produce multiple competing answers, like a real thread: exactly one accepted (the
   genuinely best, with the most votes), the rest real alternatives that are not
   near-duplicates — a quick hack, a more robust approach, a tradeoff.
3. For each answer's "author", invent a humorous spinoff of a well-known name from
   the relevant tech ecosystem — a recognizable riff, never a real handle.

OUTPUT:
Return structured data matching the schema. bodyMarkdown is normal Markdown with
fenced code blocks. Keep each answer short. If a web page you actually fetched
backs an answer, put its URL in that answer's "sources" (real pages only).`;

// JSON schema for the structured response — the SDK enforces this, so we never
// have to parse fenced JSON out of prose (and answers can contain ``` freely).
const THREAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "questionMarkdown", "tags", "answers"],
  properties: {
    title: { type: "string" },
    questionMarkdown: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    answers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["author", "reputation", "votes", "accepted", "bodyMarkdown"],
        properties: {
          author: { type: "string" },
          reputation: { type: "number" },
          votes: { type: "number" },
          accepted: { type: "boolean" },
          bodyMarkdown: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

function buildPrompt(ctx: AskContext, answerCount: number): string {
  const where = ctx.languageId
    ? `A developer asked this from their editor (working in ${ctx.languageId}${ctx.fileName ? `, file ${ctx.fileName}` : ""}).`
    : `A developer asked this from their editor.`;
  return `${where}

QUESTION: ${ctx.question || "(no question text given)"}

Their project is at ${ctx.workspaceRoot ?? "the current workspace"}. Before answering, find
out which dependencies they actually use and at what versions: read the nearest manifest
and lock file (e.g. package.json + the lock file, or the equivalent for this stack) and
consult documentation for those exact versions, so your help is accurate for the major
versions they're on. Do NOT read or rely on their own source files — only the
dependency/version/documentation information.

Then, following the GOLDEN RULE, author a generic Stack Overflow thread:
1. Distill the general, reusable question behind this.
2. Produce ${answerCount} competing answers — version-accurate but generic (never
   reference their files, code, or project structure).

Be terse.`;
}

export interface RunOptions {
  model: string;
  answerCount: number;
  apiKey?: string;
  cwd?: string;
  /** Override path to the Claude Code executable; otherwise auto-discovered. */
  claudeCodePath?: string;
  onProgress?: (e: ProgressEvent) => void;
}

/** Drives the Claude Agent SDK and returns a parsed Stack Overflow thread. */
export async function askStackOverflow(
  ctx: AskContext,
  opts: RunOptions
): Promise<SOThread> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  const claudePath = findClaudeExecutable(opts.claudeCodePath);
  if (!claudePath) {
    throw new Error(
      "Couldn't find the Claude Code executable. Install Claude Code (https://claude.com/claude-code), " +
        "or set the path in Settings → Stack Overflow AI: Claude Code Path."
    );
  }

  // Read-only allowlist: the agent investigates but never mutates the workspace.
  const READ_ONLY = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    model: opts.model,
    allowedTools: [...READ_ONLY],
    // Gate every tool call: allow the read-only set, deny anything else
    // (e.g. Bash, Write, Edit) so a question can't mutate the project.
    canUseTool: async (toolName, input) =>
      READ_ONLY.has(toolName)
        ? { behavior: "allow", updatedInput: input } // pass the tool's real args through unchanged
        : { behavior: "deny", message: `${toolName} is not allowed in read-only research mode.` },
    // Enforce the response shape natively instead of parsing fenced JSON.
    outputFormat: { type: "json_schema", schema: THREAD_SCHEMA as unknown as Record<string, unknown> },
    // Stream partial events so we can detect when answer generation *starts*
    // (the StructuredOutput tool begins), not just when it finishes.
    includePartialMessages: true,
    // Don't pull in the user's CLAUDE.md / project settings; this is a focused tool.
    settingSources: [],
    cwd: opts.cwd,
    env,
    // Use the user's installed Claude Code rather than shipping the SDK's
    // 225 MB per-platform binary in the extension.
    pathToClaudeCodeExecutable: claudePath,
  };

  let structured: unknown;

  const query = await loadQuery();
  for await (const message of query({ prompt: buildPrompt(ctx, opts.answerCount), options })) {
    if (message.type === "stream_event") {
      // Fires the moment the StructuredOutput tool *starts* streaming — i.e. the
      // agent has begun composing the answers. This is the cue for the fun state.
      const ev = message.event as { type?: string; content_block?: { type?: string; name?: string } };
      if (
        ev?.type === "content_block_start" &&
        ev.content_block?.type === "tool_use" &&
        /structured.?output/i.test(ev.content_block.name ?? "")
      ) {
        opts.onProgress?.({ kind: "final", label: "" });
      }
    } else if (message.type === "assistant") {
      let captured = false;
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        if (/structured.?output/i.test(block.name)) {
          // The tool's input IS the finished thread. Grab it and stop — no need
          // to wait for the agent's wrap-up turn or the result message.
          structured = block.input;
          captured = true;
          break;
        } else if (READ_ONLY.has(block.name)) {
          opts.onProgress?.({ kind: "tool", label: describeTool(block.name, block.input) });
        }
      }
      if (captured) break;
    } else if (message.type === "result") {
      // Fallback if we didn't capture the tool input directly above.
      if (message.subtype === "success") {
        structured = message.structured_output ?? message.result;
      } else {
        throw new Error(`Agent stopped: ${message.subtype}`);
      }
    }
  }

  return normalizeThread(structured);
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `Reading ${basename(String(i.file_path ?? ""))}`;
    case "Grep":
      return `Grepping for "${truncate(String(i.pattern ?? ""), 40)}"`;
    case "Glob":
      return `Looking for ${String(i.pattern ?? "files")}`;
    case "WebSearch":
      return `Searching the web: "${truncate(String(i.query ?? ""), 50)}"`;
    case "WebFetch":
      return `Reading ${truncate(String(i.url ?? ""), 50)}`;
    default:
      return `Using ${name}`;
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Validates/normalizes the structured response into an SOThread. */
function normalizeThread(value: unknown): SOThread {
  // structured_output is usually already an object; tolerate a JSON string too.
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      throw new Error("The agent returned malformed output: " + (e as Error).message);
    }
  }
  const thread = parsed as SOThread;
  if (!thread || !Array.isArray(thread.answers) || thread.answers.length === 0) {
    throw new Error("The agent returned no answers.");
  }
  // Guarantee exactly one accepted answer for the UI.
  if (!thread.answers.some((a) => a.accepted)) {
    thread.answers[0].accepted = true;
  }
  thread.tags = thread.tags ?? [];
  return thread;
}
