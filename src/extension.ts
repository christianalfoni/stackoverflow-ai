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
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a file and place your cursor where you have a question.");
    return;
  }

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

function captureContext(editor: vscode.TextEditor, question: string): AskContext {
  const doc = editor.document;
  const sel = editor.selection;
  const selection = doc.getText(sel);

  // Grab ~40 lines around the cursor for context without flooding the prompt.
  const cursorLine = sel.active.line;
  const start = Math.max(0, cursorLine - 20);
  const end = Math.min(doc.lineCount - 1, cursorLine + 20);
  const surrounding = doc.getText(
    new vscode.Range(start, 0, end, doc.lineAt(end).text.length)
  );

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return {
    question,
    languageId: doc.languageId,
    fileName: vscode.workspace.asRelativePath(doc.uri),
    selection,
    surrounding,
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
