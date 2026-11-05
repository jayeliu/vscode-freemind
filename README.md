# FreeMind 思维导图（VS Code 扩展）

在 VS Code 里查看和编辑 FreeMind `.mm` 思维导图，**不破坏原文件**：用不到的部分原样保留，git diff 只显示你真正改过的那一处。

## 功能

- `.mm` 文件默认以图形方式打开（左右分叉布局、贝塞尔连线）
- 折叠/展开子树，展开全部，适应窗口，滚轮平移，`Ctrl` + 滚轮缩放
- 布局可在工具栏切换：**左右分叉**（默认，读 `POSITION`）或**上下结构**（根在上、逐层向下）；选择只存在视图里，不写回文件
- 节点文本就地编辑；增删节点；拖拽改父级/顺序；Shift+Tab 提升一级
- 撤销/重做走扩展自己的补丁栈（100 步，一次操作 = 一步），每次撤销也是一次 `WorkspaceEdit`；在文本编辑器里从外部改了文件，栈会自动清空
- 搜索定位节点（`Ctrl+F` 后回车逐个跳转，自动展开祖先）
- 只读预览视图（不产生未保存标记），以及"用文本编辑器打开"
- 保存、revert、热退出备份、脏标记全部由 VS Code 处理

## 快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` | 新建同级节点（根节点上则新建子节点） |
| `Tab` | 新建子节点 |
| `Shift+Tab` | 提升一级（变成父节点的同级） |
| `F2` / 双击 | 就地编辑 |
| `Delete` / `Backspace` | 删除节点及其子树 |
| 方向键 | 在树中移动选择 |
| `Ctrl+C` / `Ctrl+V` | 复制/粘贴子树（粘贴到选中节点下，并重新分配 ID） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销/重做 |
| `Ctrl+F` | 搜索 |

编辑框内：`Enter` 提交，`Shift+Enter` 换行，`Esc` 取消。中文输入法组合中的回车不会误提交。

## 保真策略（为什么 diff 很干净）

不整篇重新序列化。所有编辑都由一个自研的、**带字节偏移的容错 XML 解析器**定位到原文的字符区间，然后只替换那一小段：

- 未知元素、未知属性、注释、XML 声明、`DOCTYPE`、实体写法（`&amp;`、`&#10;`）一律原样透传
- 节点顺序不重排，缩进不统一，新增行沿用相邻兄弟的缩进
- 新建节点生成的 ID 是 12 位十六进制，和 FreeMind 风格一致
- 标签页内文本与格式化（`richcontent`、`icon`、`cloud`、`arrowlink`、`edge`）不参与渲染，但也不会被删除

## 已知限制

- **富文本节点（`richcontent TYPE="NODE"`）被编辑时**，旧 HTML 会被替换成纯文本，并在界面上给出提示。不编辑就不会动它。
- **左右布局是推断的**：优先读 `POSITION` 属性，缺失时按子树高度自动平衡。拖到另一侧只是当前视图的改变，**不会写回 `POSITION`**，重新打开后按文件内容重新排布。
- **折叠状态只读不写**：打开时读取 `FOLDED`，界面上的折叠/展开不写回文件。
- **布局选择不写回文件**：上下/左右只是视图选项，重新打开按默认或上次的视图状态恢复。
- `richcontent TYPE="NOTE"`（备注）只读，不显示也不算编辑内容。
- 非 UTF-8 编码、或本来就非法的 XML：拒绝进入编辑并提示，绝不静默写坏文件。
- 超大文件（>1 万节点）未做虚拟化，首次布局会变慢。
- 撤销栈只存在内存里，关闭标签页即丢失。
- 只保证桌面版 VS Code；不支持 vscode.dev（需要 `node:crypto`）。

## 开发

```bash
npm install
npm run compile     # 构建到 media/
npm test            # node:test，覆盖解析、最小补丁、增删改移、布局不重叠、样本文件往返
npm run typecheck   # tsc --noEmit
```

调试：VS Code 打开本目录，按 `F5`（扩展开发宿主），打开任意 `.mm` 文件。

打包成本地 vsix：

```bash
npm run package     # 产出 mindmap-freemind-0.0.1.vsix
code --install-extension mindmap-freemind-0.0.1.vsix
```

## 结构

```
src/mm/parse.ts      带偏移的 XML 解析器（不生成 AST 文本，只记录位置）
src/mm/patch.ts      最小文本补丁：改文本、插入、删除、移动、缩进推断
src/mm/ops.ts        编辑操作 → 新文本 + 编辑后聚焦的路径
src/mm/layout.ts     纯几何布局：子树尺寸、左右分叉、上下结构
src/extension.ts     CustomTextEditorProvider、CSP、命令
src/webview/main.ts  渲染与交互（无框架，零运行时依赖）
test/mm.test.ts      node:test：解析/补丁/编辑操作
test/layout.test.ts   node:test：随机树断言节点矩形不相交
```

运行时零依赖；打包体积约 50 KB。
