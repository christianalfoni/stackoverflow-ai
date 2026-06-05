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
  /** Invented contributor handle, e.g. "types_wrangler". */
  author: string;
  /** Flavor reputation number, purely cosmetic. */
  reputation: number;
  /** Net vote count. The accepted answer usually has the most. */
  votes: number;
  /** Exactly one answer in the array should be accepted. */
  accepted: boolean;
  /** The answer body in Markdown (prose + fenced code blocks). Keep it tight. */
  bodyMarkdown: string;
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

/** Code context captured at the cursor when the user asked. */
export interface AskContext {
  question: string;
  languageId: string;
  fileName: string;
  selection: string;
  surrounding: string;
  workspaceRoot?: string;
}

/** A progress event surfaced to the webview while the agent researches. */
export interface ProgressEvent {
  kind: "tool" | "thinking" | "status";
  label: string;
}

const SYSTEM_PROMPT = `You are the engine behind "Stack Overflow AI", a tool that answers a developer's
coding question in the exact format and spirit of a Stack Overflow thread.

Your job is the opposite of a chatbot. You must be TERSE. A good Stack Overflow
answer is short: a direct solution, a minimal code block, and one or two
sentences of explanation. No preamble, no "Great question!", no restating the
problem, no closing summary. If you catch yourself writing a wall of text, cut it.

WORKFLOW:
1. Research using your tools. Read the user's actual files, grep for types in
   node_modules, check local docs, and search the web when you need authoritative
   API details. Ground every answer in what you actually found — never guess at an
   API signature you could have verified.
2. Produce MULTIPLE competing answers, like a real thread where different people
   chimed in. Exactly one is marked accepted (the genuinely best approach). The
   others should be real alternatives: a quicker hack, a more robust approach, a
   "you could also..." with a tradeoff. They should not be near-duplicates.
3. Give the accepted answer the highest vote count.

OUTPUT:
Return your answer as structured data matching the provided schema. bodyMarkdown
uses normal Markdown with fenced code blocks. Keep each answer short.`;

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
        },
      },
    },
  },
} as const;

function buildPrompt(ctx: AskContext, answerCount: number): string {
  return `A developer asked this from inside their editor:

QUESTION: ${ctx.question || "(no extra words — infer the question from the selected code)"}

FILE: ${ctx.fileName} (${ctx.languageId})

SELECTED CODE:
\`\`\`${ctx.languageId}
${ctx.selection || "(nothing selected)"}
\`\`\`

SURROUNDING CONTEXT:
\`\`\`${ctx.languageId}
${ctx.surrounding}
\`\`\`

Research as needed (their files are under ${ctx.workspaceRoot ?? "the current workspace"}), then
produce ${answerCount} competing answers in the required JSON format. Be terse.`;
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
    canUseTool: async (toolName) =>
      READ_ONLY.has(toolName)
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: `${toolName} is not allowed in read-only research mode.` },
    // Enforce the response shape natively instead of parsing fenced JSON.
    outputFormat: { type: "json_schema", schema: THREAD_SCHEMA as unknown as Record<string, unknown> },
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
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          opts.onProgress?.({ kind: "tool", label: describeTool(block.name, block.input) });
        } else if (block.type === "text" && block.text.trim()) {
          opts.onProgress?.({ kind: "thinking", label: "Drafting answers…" });
        }
      }
    } else if (message.type === "result") {
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
