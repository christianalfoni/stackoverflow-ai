import * as vscode from "vscode";
import { askStackOverflow, type AskContext } from "./agent";
import { getWebviewHtml } from "./webview";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("stackoverflowAI.ask", () => askCommand(context))
  );
}

export function deactivate() {}

let currentPanel: vscode.WebviewPanel | undefined;

async function askCommand(context: vscode.ExtensionContext) {
  // An open editor is optional — you can ask a question regardless of what
  // (if anything) is focused in the editor.
  const editor = vscode.window.activeTextEditor;

  const question = await vscode.window.showInputBox({
    prompt: "What are you trying to figure out?",
    placeHolder: "e.g. How do I stream a response from this API?",
    ignoreFocusOut: true,
  });
  if (question === undefined) {
    return; // user cancelled
  }

  const ctx = captureContext(editor, question);
  const panel = ensurePanel(context);

  panel.webview.postMessage({ type: "question", ctx });

  const config = vscode.workspace.getConfiguration("stackoverflowAI");
  const apiKey = config.get<string>("anthropicApiKey") || undefined;
  const model = config.get<string>("model") || "claude-sonnet-4-6";
  const answerCount = config.get<number>("answerCount") ?? 3;
  const claudeCodePath = config.get<string>("claudeCodePath") || undefined;

  try {
    const thread = await askStackOverflow(ctx, {
      model,
      answerCount,
      apiKey,
      cwd: ctx.workspaceRoot,
      claudeCodePath,
      onProgress: (event) => panel.webview.postMessage({ type: "progress", event }),
    });
    panel.webview.postMessage({ type: "thread", thread });
  } catch (err) {
    panel.webview.postMessage({ type: "error", message: (err as Error).message });
  }
}

function captureContext(editor: vscode.TextEditor | undefined, question: string): AskContext {
  // Deliberately lightweight: no file contents or selection (that just adds
  // latency and pulls answers toward the user's code). The agent inspects the
  // project's dependencies/versions itself when it needs to. The editor is
  // optional — when nothing is open we just fall back to the workspace folder.
  const doc = editor?.document;
  const workspaceRoot = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath)
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return {
    question,
    languageId: doc?.languageId,
    fileName: doc ? vscode.workspace.asRelativePath(doc.uri) : undefined,
    workspaceRoot,
  };
}

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    return currentPanel;
  }
  const panel = vscode.window.createWebviewPanel(
    "stackoverflowAI",
    "Stack Overflow AI",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    }
  );
  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(msg));
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });
  currentPanel = panel;
  return panel;
}

function handleWebviewMessage(msg: any) {
  if (!msg || typeof msg !== "object") {
    return;
  }
  if (msg.type === "copy" && typeof msg.code === "string") {
    vscode.env.clipboard.writeText(msg.code);
    vscode.window.setStatusBarMessage("Copied snippet", 2000);
  }
}
