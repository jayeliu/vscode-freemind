import {
  attrValue,
  childNodes,
  mapElement,
  nodeText,
  parseXml,
  rootNode,
  type XmlElement,
} from '../mm/parse.ts';
import { layoutBoxes, measureBoxes } from '../mm/layout.ts';
import type { LayoutMode, Side } from '../mm/layout.ts';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface MNode {
  id: string;
  path: number[];
  text: string;
  raw: string;
  rich: boolean;
  el: XmlElement;
  parent: MNode | null;
  children: MNode[];
  side: Side;
  lines: string[];
  w: number;
  h: number;
  subtreeH: number;
  subtreeW: number;
  x: number;
  y: number;
  collapsed: boolean;
}

interface DocMessage {
  type: 'doc';
  text: string;
  readOnly: boolean;
  editPath?: number[];
  selectPath?: number[];
}

const NS = 'http://www.w3.org/2000/svg';
const FONT_SIZE = 13;
const LINE_H = 18;
const PAD_X = 10;
const PAD_Y = 6;
const MAX_W = 240;
const FONT = `${FONT_SIZE}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;

const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = FONT;

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as unknown as SVGSVGElement;
const viewport = document.getElementById('viewport') as unknown as SVGGElement;
const edgesLayer = document.getElementById('edges') as unknown as SVGGElement;
const nodesLayer = document.getElementById('nodes') as unknown as SVGGElement;
const editorLayer = document.getElementById('editor-layer') as HTMLDivElement;
const banner = document.getElementById('banner') as HTMLDivElement;
const countLabel = document.getElementById('count') as HTMLSpanElement;
const zoomLabel = document.getElementById('zoom-label') as HTMLSpanElement;
const searchInput = document.getElementById('search') as HTMLInputElement;
const layoutSelect = document.getElementById('layout') as HTMLSelectElement;
const readOnlyBadge = document.getElementById('readonly-badge') as HTMLSpanElement;

let model: MNode | null = null;
let flat: MNode[] = [];
const byId = new Map<string, MNode>();

let docText = '';
let readOnly = false;
let selectedId: string | null = null;
const collapsedIds = new Set<string>();
let collapsedInit = false;

let editing: { node: MNode; area: HTMLTextAreaElement } | null = null;

let zoom = 1;
let panX = 0;
let panY = 0;

let query = '';
let matches: MNode[] = [];
let matchIndex = -1;
let placed = false;

// 布局只存在 webview 状态里（不写回文件）
const savedState = vscode.getState() as { layout?: LayoutMode } | undefined;
let layoutMode: LayoutMode = savedState?.layout === 'down' ? 'down' : 'both';
layoutSelect.value = layoutMode;

/* ---------------------------------------------------------------- 模型 */

function cut(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of Array.from(para)) {
      if (line && measureCtx.measureText(line + ch).width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

function buildModel(text: string): MNode {
  const map = rootNode(mapElement(parseXml(text)));
  const build = (el: XmlElement, path: number[], parent: MNode | null): MNode => {
    const raw = nodeText(text, el);
    const rich = !el.attrs.some((a) => a.name === 'TEXT') && el.children.some((c) => c.name === 'richcontent');
    const node: MNode = {
      id: attrValue(el, 'ID') || `#${path.join('.')}`,
      path,
      text: raw,
      raw,
      rich,
      el,
      parent,
      children: [],
      side: parent ? parent.side : 'root',
      lines: [],
      w: 0,
      h: 0,
      subtreeH: 0,
      subtreeW: 0,
      x: 0,
      y: 0,
      collapsed: collapsedIds.has(attrValue(el, 'ID') || `#${path.join('.')}`),
    };
    node.children = childNodes(el).map((child, i) => build(child, [...path, i], node));
    return node;
  };
  const root = build(map, [], null);
  root.side = 'root';

  if (!collapsedInit) {
    collapsedInit = true;
    // FreeMind 存下来的折叠状态只读一次，之后只在内存里改，不写回文件
    for (const node of walk(root)) {
      if ((attrValue(node.el, 'FOLDED') ?? '').toLowerCase() === 'true') {
        collapsedIds.add(node.id);
        node.collapsed = true;
      }
    }
  }

  reflow(root);
  flat = [root, ...walk(root)];
  byId.clear();
  for (const node of flat) byId.set(node.id, node);
  return root;
}

function* walk(node: MNode): Generator<MNode> {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

function measure(node: MNode): void {
  const lines = cut(node.text || ' ', MAX_W - PAD_X * 2);
  node.lines = lines;
  let width = 0;
  for (const line of lines) width = Math.max(width, measureCtx.measureText(line).width);
  node.w = Math.max(56, Math.ceil(width) + PAD_X * 2 + 2);
  node.h = lines.length * LINE_H + PAD_Y * 2;
  for (const child of node.children) measure(child);
}

function reflow(root: MNode): void {
  measure(root);
  measureBoxes(root);
  if (layoutMode !== 'down') prepareSides(root);
  layoutBoxes(root, layoutMode);
}

/** 左右分叉：先按 POSITION 或子树高度给根的一级子节点定边。 */
function prepareSides(root: MNode): void {
  let leftH = 0;
  let rightH = 0;
  for (const child of root.children) {
    const declared = (attrValue(child.el, 'POSITION') ?? '').toLowerCase();
    const side: Side =
      declared === 'left' ? 'left' : declared === 'right' ? 'right' : rightH <= leftH ? 'right' : 'left';
    child.side = side;
    if (side === 'left') leftH += child.subtreeH;
    else rightH += child.subtreeH;
  }
}

/* ---------------------------------------------------------------- 视图 */

function svg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, name);
}

function applyTransform(): void {
  viewport.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function render(): void {
  if (!model) return;
  edgesLayer.replaceChildren();
  nodesLayer.replaceChildren();

  const selected = selectedId ? byId.get(selectedId) : null;
  const matchIds = new Set(matches.map((n) => n.id));

  for (const node of flat) {
    if (isHidden(node)) continue;
    if (node.parent) drawEdge(node.parent, node);
    nodesLayer.appendChild(drawNode(node, node === selected, matchIds.has(node.id)));
  }

  countLabel.textContent = `${flat.length} 个节点`;
  readOnlyBadge.hidden = !readOnly;
  applyTransform();
}

function isHidden(node: MNode): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur.collapsed) return true;
  return false;
}

function drawEdge(parent: MNode, child: MNode): void {
  const path = svg('path');
  path.setAttribute('class', 'edge');
  if (child.side === 'down') {
    const x1 = parent.x + parent.w / 2;
    const y1 = parent.y + parent.h;
    const x2 = child.x + child.w / 2;
    const y2 = child.y;
    const mid = (y1 + y2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
    edgesLayer.appendChild(path);
    return;
  }
  const fromRight = child.side !== 'left';
  const x1 = fromRight ? parent.x + parent.w : parent.x;
  const y1 = parent.y + parent.h / 2;
  const x2 = fromRight ? child.x : child.x + child.w;
  const y2 = child.y + child.h / 2;
  const mid = (x1 + x2) / 2;
  path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
  edgesLayer.appendChild(path);
}

function drawNode(node: MNode, selected: boolean, matched: boolean): SVGGElement {
  const group = svg('g');
  group.setAttribute('transform', `translate(${node.x} ${node.y})`);
  group.setAttribute('class', `node ${node.side}${selected ? ' selected' : ''}${matched ? ' match' : ''}`);
  group.dataset.id = node.id;

  const rect = svg('rect');
  rect.setAttribute('width', String(node.w));
  rect.setAttribute('height', String(node.h));
  rect.setAttribute('rx', '6');
  rect.setAttribute('ry', '6');
  group.appendChild(rect);

  const text = svg('text');
  node.lines.forEach((line, i) => {
    const tspan = svg('tspan');
    tspan.setAttribute('x', String(PAD_X));
    tspan.setAttribute('y', String(PAD_Y + FONT_SIZE + i * LINE_H));
    tspan.textContent = line === '' ? ' ' : line;
    text.appendChild(tspan);
  });
  group.appendChild(text);

  if (node.children.length > 0) {
    const down = node.side === 'down';
    const cx = down ? node.w / 2 : node.side === 'left' ? -8 : node.w + 8;
    const cy = down ? node.h + 8 : node.h / 2;
    const dot = svg('circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '5');
    dot.setAttribute('class', 'toggle');
    dot.dataset.toggle = node.id;
    group.appendChild(dot);
    if (node.collapsed) {
      const label = svg('text');
      label.setAttribute('x', String(cx));
      label.setAttribute('y', String(cy + 4));
      label.setAttribute('class', 'fold-count');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = `${node.children.length}`;
      group.appendChild(label);
    }
  }
  return group;
}

function fit(): void {
  if (!model) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of flat) {
    if (isHidden(node)) continue;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  if (!Number.isFinite(minX)) return;
  const rect = stage.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return; // 布局未完成时先不缩放，等下一次 resize/fit
  const pad = 40;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  zoom = Math.min(2, Math.max(0.2, Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height)));
  panX = (rect.width - width * zoom) / 2 - minX * zoom;
  panY = (rect.height - height * zoom) / 2 - minY * zoom;
  applyTransform();
}

function centerOn(node: MNode): void {
  const rect = stage.getBoundingClientRect();
  panX = rect.width / 2 - (node.x + node.w / 2) * zoom;
  panY = rect.height / 2 - (node.y + node.h / 2) * zoom;
  applyTransform();
}

/* ---------------------------------------------------------------- 消息 */

function post(message: unknown): void {
  vscode.postMessage(message);
}

function sendOp(op: unknown): void {
  if (readOnly) return;
  post({ type: 'op', op });
}

function showBanner(text: string): void {
  banner.textContent = text;
  banner.hidden = !text;
}

let bannerTimer = 0;
function flash(text: string): void {
  showBanner(text);
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => showBanner(''), 2500);
}

function select(node: MNode | null, recenter = true): void {
  if (node && expandTo(node)) relayout();
  selectedId = node ? node.id : null;
  render();
  if (node) {
    // 搜索框处于输入状态时不要抢焦点，否则边打字边跳走
    if (!(document.activeElement instanceof HTMLInputElement)) canvas.focus({ preventScroll: true });
    if (recenter) {
      const rect = stage.getBoundingClientRect();
      const sx = panX + (node.x + node.w / 2) * zoom;
      const sy = panY + (node.y + node.h / 2) * zoom;
      if (sx < 40 || sx > rect.width - 40 || sy < 40 || sy > rect.height - 40) centerOn(node);
    }
    saveState();
  }
}

function saveState(): void {
  vscode.setState({ zoom, panX, panY, selectedId, layout: layoutMode });
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as DocMessage | undefined;
  if (!message || message.type !== 'doc') return;

  readOnly = Boolean(message.readOnly);
  if (editing) return; // 自己的编辑还没提交，忽略回推

  docText = message.text;
  try {
    model = buildModel(docText);
    showBanner('');
  } catch (error) {
    showBanner(`无法解析：${(error as Error).message}（文件没有改动）`);
    return;
  }

  const target = message.editPath
    ? nodeAtPath(message.editPath)
    : message.selectPath
      ? nodeAtPath(message.selectPath)
      : selectedId
        ? byId.get(selectedId) ?? null
        : model;

  selectedId = target ? target.id : model.id;
  refreshMatches();
  if (!placed) {
    placed = true;
    fit();
  }
  render();
  saveState();

  if (message.editPath && target) startEdit(target);
});

/* ---------------------------------------------------------------- 查询 */

function nodeAtPath(path: readonly number[]): MNode | null {
  if (!model) return null;
  let node: MNode = model;
  for (const index of path) {
    const next = node.children[index];
    if (!next) return null;
    node = next;
  }
  return node;
}

function refreshMatches(): void {
  const q = query.trim().toLowerCase();
  matches = q ? flat.filter((n) => n.text.toLowerCase().includes(q)) : [];
  matchIndex = -1;
}

/* ---------------------------------------------------------------- 编辑 */

function startEdit(node: MNode): void {
  if (readOnly) {
    showBanner('只读预览，无法编辑；请用「重新打开方式 → 思维导图编辑器」。');
    return;
  }
  if (editing) cancelEdit();
  const area = document.createElement('textarea');
  area.className = 'inline-editor';
  area.value = node.raw;
  area.spellcheck = false;
  const width = Math.max(120, node.w * zoom);
  const height = Math.max(28, node.h * zoom);
  area.style.left = `${panX + node.x * zoom}px`;
  area.style.top = `${panY + node.y * zoom}px`;
  area.style.width = `${width}px`;
  area.style.height = `${height}px`;
  area.style.fontSize = `${Math.max(9, FONT_SIZE * zoom)}px`;
  area.style.lineHeight = `${Math.max(12, LINE_H * zoom)}px`;
  area.style.padding = `${PAD_Y * zoom}px ${PAD_X * zoom}px`;
  editorLayer.replaceChildren(area);
  editing = { node, area };
  if (node.rich) showBanner('该节点是富文本（richcontent），编辑后会被替换成纯文本。');

  let composing = false;
  area.addEventListener('compositionstart', () => (composing = true));
  area.addEventListener('compositionend', () => (composing = false));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) {
      event.preventDefault();
      commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      commitEdit();
    }
  });
  area.addEventListener('blur', () => {
    if (editing) commitEdit();
  });
  area.focus();
  area.select();
}

function commitEdit(): void {
  if (!editing) return;
  const { node, area } = editing;
  editing = null;
  editorLayer.replaceChildren();
  const value = area.value;
  showBanner('');
  if (value === node.raw) {
    render();
    return;
  }
  sendOp({ type: 'setText', path: node.path, text: value });
}

function cancelEdit(): void {
  if (!editing) return;
  editing = null;
  editorLayer.replaceChildren();
  showBanner('');
  render();
}

/* ---------------------------------------------------------------- 操作 */

function addChild(): void {
  const node = selectedId ? byId.get(selectedId) : model;
  if (!node) return;
  sendOp({ type: 'addChild', path: node.path });
}

function addSibling(before: boolean): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node) return;
  if (!node.parent) {
    addChild();
    return;
  }
  sendOp({ type: 'addSibling', path: node.path, before });
}

function removeSelected(): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node) return;
  if (!node.parent) {
    showBanner('根节点不能删除。');
    return;
  }
  sendOp({ type: 'remove', path: node.path });
}

let clipboard: string | null = null;

function copySelected(): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node) return;
  clipboard = docText.slice(node.el.start, node.el.end);
  flash('已复制该节点及其子树，Ctrl+V 粘贴到选中节点下。');
}

function pasteInto(): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node || !clipboard) return;
  sendOp({ type: 'paste', path: node.path, xml: clipboard });
}

function promote(): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node || !node.parent || node.path.length < 2) return;
  const parentPath = node.path.slice(0, -1);
  const grandPath = parentPath.slice(0, -1);
  const parentIndex = parentPath[parentPath.length - 1]!;
  sendOp({ type: 'move', from: node.path, parent: grandPath, index: parentIndex + 1 });
}

function toggleFold(node: MNode): void {
  node.collapsed = !node.collapsed;
  if (node.collapsed) collapsedIds.add(node.id);
  else collapsedIds.delete(node.id);
  relayout();
  render();
}

function expandTo(node: MNode): boolean {
  let changed = false;
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.collapsed) {
      cur.collapsed = false;
      collapsedIds.delete(cur.id);
      changed = true;
    }
  }
  return changed;
}

function relayout(): void {
  if (!model) return;
  reflow(model);
  flat = [model, ...walk(model)];
  byId.clear();
  for (const node of flat) byId.set(node.id, node);
}

function navigate(direction: 'up' | 'down' | 'left' | 'right'): void {
  const node = selectedId ? byId.get(selectedId) : null;
  if (!node) return;
  if (direction === 'left' || direction === 'right') {
    if (layoutMode === 'down') {
      // 上下结构：右=进子级，左=回父级
      if (direction === 'right' && node.children.length && !node.collapsed) select(node.children[0]!);
      else if (node.parent) select(node.parent);
      return;
    }
    const outward = node.side === 'left' ? 'left' : 'right';
    if (direction === outward && node.children.length && !node.collapsed) {
      select(node.children[0]!);
    } else if (node.parent) {
      select(node.parent);
    }
    return;
  }
  const siblings = node.parent ? node.parent.children : [];
  const index = siblings.indexOf(node);
  const next = siblings[index + (direction === 'up' ? -1 : 1)];
  if (next) select(next);
}

/* ---------------------------------------------------------------- 输入 */

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const inField =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;

  if (event.key === 'Escape' && target === searchInput) {
    searchInput.blur();
    searchInput.value = '';
    query = '';
    refreshMatches();
    render();
    return;
  }
  if (inField) {
    if (event.key === 'Enter' && target === searchInput) {
      event.preventDefault();
      if (matches.length) {
        matchIndex = (matchIndex + 1) % matches.length;
        select(matches[matchIndex]!);
      }
    }
    return;
  }
  if (editing) return;
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      post({ type: 'undo' });
      return;
    }
    if (key === 'y') {
      event.preventDefault();
      post({ type: 'redo' });
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      copySelected();
      return;
    }
    if (key === 'v') {
      event.preventDefault();
      pasteInto();
      return;
    }
    return;
  }

  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      addSibling(false);
      return;
    case 'Tab':
      event.preventDefault();
      if (event.shiftKey) promote();
      else addChild();
      return;
    case 'F2':
      event.preventDefault();
      if (selectedId && byId.has(selectedId)) startEdit(byId.get(selectedId)!);
      return;
    case 'Delete':
    case 'Backspace':
      event.preventDefault();
      removeSelected();
      return;
    case 'ArrowUp':
      event.preventDefault();
      navigate('up');
      return;
    case 'ArrowDown':
      event.preventDefault();
      navigate('down');
      return;
    case 'ArrowLeft':
      event.preventDefault();
      navigate('left');
      return;
    case 'ArrowRight':
      event.preventDefault();
      navigate('right');
      return;
    default:
      return;
  }
});

canvas.addEventListener('click', (event) => {
  const target = event.target as Element;
  const toggle = target.closest('[data-toggle]');
  if (toggle) {
    event.stopPropagation();
    const node = byId.get((toggle as SVGGElement).dataset.toggle!);
    if (node) toggleFold(node);
    return;
  }
  const group = target.closest('.node') as SVGGElement | null;
  select(group ? byId.get(group.dataset.id!) ?? null : null, false);
});

canvas.addEventListener('dblclick', (event) => {
  const group = (event.target as Element).closest('.node') as SVGGElement | null;
  if (!group) return;
  const node = byId.get(group.dataset.id!);
  if (node) startEdit(node);
});

let panning: { x: number; y: number; px: number; py: number } | null = null;
let drag: { node: MNode; x: number; y: number; active: boolean } | null = null;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  canvas.focus({ preventScroll: true });
  const group = (event.target as Element).closest('.node') as SVGGElement | null;
  if (group && !(event.target as Element).closest('[data-toggle]')) {
    const node = byId.get(group.dataset.id!);
    if (node) {
      drag = { node, x: event.clientX, y: event.clientY, active: false };
      select(node, false);
      return;
    }
  }
  panning = { x: event.clientX, y: event.clientY, px: panX, py: panY };
});

window.addEventListener('pointermove', (event) => {
  if (panning) {
    panX = panning.px + (event.clientX - panning.x);
    panY = panning.py + (event.clientY - panning.y);
    applyTransform();
    return;
  }
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.active = true;
    document.body.classList.add('dragging');
    const ghost = document.createElement('div');
    ghost.id = 'drag-ghost';
    ghost.textContent = drag.node.text.split('\n')[0] || '(空)';
    ghost.style.left = `${event.clientX + 12}px`;
    ghost.style.top = `${event.clientY + 12}px`;
    document.body.appendChild(ghost);
  }
  const ghost = document.getElementById('drag-ghost');
  if (ghost) {
    ghost.style.left = `${event.clientX + 12}px`;
    ghost.style.top = `${event.clientY + 12}px`;
  }
  highlightDrop(event.clientX, event.clientY);
});

window.addEventListener('pointerup', (event) => {
  if (panning) {
    panning = null;
    return;
  }
  if (!drag) return;
  const dragging = drag;
  drag = null;
  document.body.classList.remove('dragging');
  document.getElementById('drag-ghost')?.remove();
  clearDropHighlight();
  if (!dragging.active || readOnly) return;
  const drop = dropTarget(event.clientX, event.clientY, dragging.node);
  if (drop) sendOp({ type: 'move', from: dragging.node.path, parent: drop.parent, index: drop.index });
});

window.addEventListener('pointercancel', () => {
  panning = null;
  drag = null;
  document.body.classList.remove('dragging');
  document.getElementById('drag-ghost')?.remove();
  clearDropHighlight();
});

function hitNode(clientX: number, clientY: number): MNode | null {
  const element = document.elementFromPoint(clientX, clientY) as Element | null;
  const group = element?.closest('.node') as SVGGElement | null;
  if (!group) return null;
  return byId.get(group.dataset.id!) ?? null;
}

function isDescendant(candidate: MNode, node: MNode): boolean {
  for (let cur: MNode | null = candidate.parent; cur; cur = cur.parent) if (cur === node) return true;
  return false;
}

type DropMode = 'before' | 'after' | 'child';

function dropMode(clientX: number, clientY: number, target: MNode): DropMode {
  const group = nodesLayer.querySelector(`[data-id="${cssEscape(target.id)}"]`) as SVGGElement | null;
  if (!group) return 'child';
  const rect = group.getBoundingClientRect();
  // 分叉布局里上下是前后，上下结构里左右是前后
  const rel =
    layoutMode === 'down'
      ? (clientX - rect.left) / Math.max(1, rect.width)
      : (clientY - rect.top) / Math.max(1, rect.height);
  if (rel < 0.3) return 'before';
  if (rel > 0.7) return 'after';
  return 'child';
}

function dropTarget(clientX: number, clientY: number, dragged: MNode): { parent: number[]; index: number } | null {
  const target = hitNode(clientX, clientY);
  if (!target) return null;
  if (target === dragged || isDescendant(target, dragged)) return null;
  const mode = dropMode(clientX, clientY, target);
  if (mode === 'child') return { parent: target.path, index: target.children.length };
  if (!target.parent) return null;
  const parentPath = target.path.slice(0, -1);
  const index = target.path[target.path.length - 1]! + (mode === 'after' ? 1 : 0);
  return { parent: parentPath, index };
}

function highlightDrop(clientX: number, clientY: number): void {
  clearDropHighlight();
  if (!drag) return;
  const target = hitNode(clientX, clientY);
  if (!target || target === drag.node || isDescendant(target, drag.node)) return;
  const group = nodesLayer.querySelector(`[data-id="${cssEscape(target.id)}"]`) as SVGGElement | null;
  if (group) group.classList.add(`drop-${dropMode(clientX, clientY, target)}`);
}

function clearDropHighlight(): void {
  for (const element of nodesLayer.querySelectorAll('.node')) {
    element.classList.remove('drop-before', 'drop-after', 'drop-child');
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/(["\\])/g, '\\$1');
}

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(3, Math.max(0.2, zoom * factor));
      panX = x - ((x - panX) * next) / zoom;
      panY = y - ((y - panY) * next) / zoom;
      zoom = next;
    } else {
      panX -= event.deltaX;
      panY -= event.deltaY;
    }
    applyTransform();
    saveState();
  },
  { passive: false },
);

searchInput.addEventListener('input', () => {
  query = searchInput.value;
  refreshMatches();
  render();
  if (matches.length && query.trim()) {
    matchIndex = 0;
    select(matches[0]!);
  }
});

document.getElementById('zoom-in')!.addEventListener('click', () => {
  zoom = Math.min(3, zoom * 1.2);
  applyTransform();
});
document.getElementById('zoom-out')!.addEventListener('click', () => {
  zoom = Math.max(0.2, zoom / 1.2);
  applyTransform();
});
document.getElementById('fit')!.addEventListener('click', fit);
document.getElementById('open-text')!.addEventListener('click', () => post({ type: 'openText' }));
document.getElementById('unfold')!.addEventListener('click', () => {
  if (!model) return;
  collapsedIds.clear();
  for (const node of flat) node.collapsed = false;
  relayout();
  render();
});

window.addEventListener('resize', () => {
  if (editing) cancelEdit();
});

// 工具栏按钮点完后把焦点还给画布，免得 Delete/方向键作用到按钮上
for (const button of document.querySelectorAll('#toolbar button, #toolbar input')) {
  button.addEventListener('click', () => canvas.focus({ preventScroll: true }));
}

layoutSelect.addEventListener('change', () => {
  layoutMode = layoutSelect.value === 'down' ? 'down' : 'both';
  relayout();
  render();
  fit();
  saveState();
  canvas.focus({ preventScroll: true });
});

post({ type: 'ready' });
