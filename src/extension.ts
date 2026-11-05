import * as vscode from 'vscode';
import { applyOp } from './mm/ops.ts';
import { minimalPatch } from './mm/patch.ts';

const EDITOR_VIEW = 'mindmap.editor';
const PREVIEW_VIEW = 'mindmap.preview';

export function activate(context: vscode.ExtensionContext): void {
  const editProvider = new MindMapEditorProvider(context, false);
  const previewProvider = new MindMapEditorProvider(context, true);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW, editProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(PREVIEW_VIEW, previewProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('mindmap.openPreview', (uri?: vscode.Uri) => openWith(uri, PREVIEW_VIEW)),
    vscode.commands.registerCommand('mindmap.openText', (uri?: vscode.Uri) => openText(uri)),
  );
}

export function deactivate(): void {
  // 无需清理：面板与监听都挂在各自的 Disposable 上
}

async function openWith(uri: vscode.Uri | undefined, viewType: string): Promise<void> {
  const target = uri ?? activeResource();
  if (!target) {
    void vscode.window.showWarningMessage('请先打开一个 .mm 文件');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

/** 用内置文本编辑器打开：.mm 的 custom editor 是默认编辑器，'default' 不可靠。 */
async function openText(uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? activeResource();
  if (!target) {
    void vscode.window.showWarningMessage('请先打开一个 .mm 文件');
    return;
  }
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { preview: false });
}

function activeResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'openText' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'op'; op: Parameters<typeof applyOp>[1] };

class MindMapEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly readOnly: boolean,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

    // 自建撤销栈：webview 抢走焦点后 vscode 的 undo 命令不一定路由到这里，
    // 每条记录都通过 WorkspaceEdit 应用，所以不绕过文档模型。
    const history: { undo: string[]; redo: string[] } = { undo: [], redo: [] };
    let expected: string | null = null;

    const send = (editPath?: number[], selectPath?: number[]): void => {
      void panel.webview.postMessage({
        type: 'doc',
        text: document.getText(),
        readOnly: this.readOnly,
        editPath,
        selectPath,
      });
    };

    const applyText = async (next: string): Promise<boolean> => {
      const before = document.getText();
      const patch = minimalPatch(before, next);
      if (!patch) return false;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(patch.start), document.positionAt(patch.end)),
        patch.text,
      );
      try {
        expected = next;
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('编辑器拒绝了这次修改');
      } catch (error) {
        expected = null;
        throw error;
      }
      return true;
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== key) return;
      // 外部改动（文本编辑器、git 等）让自建栈失效，避免撤到别处去
      if (expected !== null && document.getText() === expected) expected = null;
      else {
        history.undo.length = 0;
        history.redo.length = 0;
      }
      send();
    });

    const messageSub = panel.webview.onDidReceiveMessage(async (raw: IncomingMessage) => {
      switch (raw?.type) {
        case 'ready':
          send();
          return;
        case 'openText':
          await openText(document.uri);
          return;
        case 'undo':
        case 'redo': {
          if (this.readOnly) return;
          const from = raw.type === 'undo' ? history.undo : history.redo;
          const to = raw.type === 'undo' ? history.redo : history.undo;
          const previous = from.pop();
          if (previous === undefined) return;
          try {
            to.push(document.getText());
            await applyText(previous);
          } catch (error) {
            to.pop();
            from.push(previous);
            void vscode.window.showErrorMessage(`思维导图：${(error as Error).message}`);
          }
          send();
          return;
        }
        case 'op': {
          if (this.readOnly) return;
          try {
            const before = document.getText();
            if (before.includes('\uFFFD')) {
              throw new Error('文件不是 UTF-8 编码（含无法解码的字节），为避免写坏文件已拒绝编辑。');
            }
            const result = applyOp(before, raw.op);
            if (!(await applyText(result.text))) throw new Error('这次操作没有产生任何改动');
            history.undo.push(before);
            if (history.undo.length > 100) history.undo.shift();
            history.redo.length = 0;
            send(result.editPath, result.selectPath);
          } catch (error) {
            void vscode.window.showErrorMessage(`思维导图：${(error as Error).message}`);
            send();
          }
          return;
        }
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });

    panel.webview.html = webviewHtml(panel.webview, mediaRoot);
  }
}

function webviewHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>FreeMind</title>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="zoom-out" title="缩小">−</button>
    <span id="zoom-label">100%</span>
    <button id="zoom-in" title="放大">＋</button>
    <button id="fit" title="适应窗口">适应</button>
    <select id="layout" title="布局方式">
      <option value="both">左右分叉</option>
      <option value="down">上下结构</option>
    </select>
    <button id="unfold" title="展开全部">展开</button>
    <button id="open-text" title="用文本编辑器打开">源码</button>
    <span id="readonly-badge" hidden>只读预览</span>
    <span class="spacer"></span>
    <span id="count"></span>
    <input id="search" type="search" placeholder="搜索节点（Ctrl+F）" spellcheck="false" autocomplete="off">
  </div>
  <div id="banner" hidden></div>
  <div id="stage">
    <svg id="canvas" tabindex="0">
      <g id="viewport">
        <g id="edges"></g>
        <g id="nodes"></g>
      </g>
    </svg>
    <div id="editor-layer"></div>
  </div>
</div>
<script src="${script}"></script>
</body>
</html>`;
}
