/**
 * 最小文本补丁：所有编辑都退回成「对原始文本的一次区间替换」，
 * 未触碰的内容（未知属性、未知元素、缩进、实体写法）保持字节不变。
 */
import {
  attrValue,
  childNodes,
  findAttr,
  mapElement,
  parseXml,
  resolveNode,
  rootNode,
  type XmlElement,
} from './parse.ts';

export interface TextPatch {
  start: number;
  end: number;
  text: string;
}

/** 由新旧文本推出最小替换区间；相同则返回 null。 */
export function minimalPatch(before: string, after: string): TextPatch | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  return { start, end: beforeEnd, text: after.slice(start, afterEnd) };
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n/g, '&#10;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

export function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

export function indentAt(text: string, pos: number): string {
  const start = lineStart(text, pos);
  const match = /^[ \t]*/.exec(text.slice(start, pos));
  return match ? match[0] : '';
}

function isBlank(value: string): boolean {
  return /^[ \t]*$/.test(value);
}

/** 从现有的父子缩进差里推断缩进单位，推断不出来就用两个空格。 */
export function indentUnit(text: string): string {
  const match = /\n([ \t]+)<node\b[^>]*>\n([ \t]+)<node\b/.exec(text);
  if (match) {
    const parentIndent = match[1]!;
    const childIndent = match[2]!;
    if (childIndent.length > parentIndent.length && childIndent.startsWith(parentIndent)) {
      return childIndent.slice(parentIndent.length);
    }
  }
  return '  ';
}

export function childIndentOf(text: string, parent: XmlElement): string {
  const kids = childNodes(parent);
  if (kids.length) return indentAt(text, kids[0]!.start);
  return indentAt(text, parent.start) + indentUnit(text);
}

/** 删除一个节点；若它独占一行则连整行一起删掉，避免留下空行。 */
export function removeNode(text: string, el: XmlElement): string {
  const ls = lineStart(text, el.start);
  const before = text.slice(ls, el.start);
  const nl = text.indexOf('\n', el.end);
  const lineEnd = nl < 0 ? text.length : nl;
  const after = text.slice(el.end, lineEnd);
  const start = isBlank(before) ? ls : el.start;
  const end = nl >= 0 && isBlank(after) ? nl + 1 : el.end;
  return text.slice(0, start) + text.slice(end);
}

/** 在 parent 的第 index 个子节点前插入一段 XML。 */
export function insertChild(text: string, parent: XmlElement, index: number, childXml: string): string {
  const kids = childNodes(parent);
  const multiline = text.includes('\n');
  const parentIndent = indentAt(text, parent.start);
  const childIndent = childIndentOf(text, parent);

  if (parent.selfClosing) {
    const slash = text.lastIndexOf('/', parent.end - 1);
    if (slash < parent.start) throw new Error('无法定位自闭合标签');
    const inner = multiline ? `\n${childIndent}${childXml}\n${parentIndent}` : childXml;
    return text.slice(0, slash) + `>${inner}</${parent.name}>` + text.slice(parent.end);
  }

  const anchor = index < kids.length ? kids[index]! : null;
  const anchorPos = anchor ? anchor.start : parent.closeStart;
  const anchorLineStart = lineStart(text, anchorPos);
  if (multiline && isBlank(text.slice(anchorLineStart, anchorPos))) {
    return text.slice(0, anchorLineStart) + childIndent + childXml + '\n' + text.slice(anchorLineStart);
  }
  return text.slice(0, anchorPos) + childXml + text.slice(anchorPos);
}

/**
 * 改写节点文本。
 * 若节点是 richcontent(TYPE=NODE) 形式，旧 HTML 会被移除 —— 用户主动编辑该节点时才会发生，
 * 属于已知的有损点（见 README）。
 */
export function setNodeText(text: string, el: XmlElement, value: string): string {
  let next = text;
  const rich = el.children
    .filter((c) => c.name === 'richcontent' && (attrValue(c, 'TYPE') ?? 'NODE').toUpperCase() === 'NODE')
    .sort((a, b) => b.start - a.start);
  for (const richEl of rich) {
    const ls = lineStart(next, richEl.start);
    const before = next.slice(ls, richEl.start);
    const nl = next.indexOf('\n', richEl.end);
    const lineEnd = nl < 0 ? next.length : nl;
    const after = next.slice(richEl.end, lineEnd);
    const start = isBlank(before) ? ls : richEl.start;
    const end = nl >= 0 && isBlank(after) ? nl + 1 : richEl.end;
    next = next.slice(0, start) + next.slice(end);
  }

  const escaped = escapeAttr(value);
  const attr = findAttr(el, 'TEXT');
  if (attr) return next.slice(0, attr.valueStart) + escaped + next.slice(attr.valueEnd);
  const insertAt = el.start + 1 + el.name.length;
  return next.slice(0, insertAt) + ` TEXT="${escaped}"` + next.slice(insertAt);
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function pathOf(root: XmlElement, target: XmlElement): number[] | null {
  if (root === target) return [];
  const kids = childNodes(root);
  for (let i = 0; i < kids.length; i++) {
    const nested = pathOf(kids[i]!, target);
    if (nested) return [i, ...nested];
  }
  return null;
}

function isAncestorOrSelf(candidate: XmlElement, node: XmlElement): boolean {
  for (let cur: XmlElement | null = node; cur; cur = cur.parent) {
    if (cur === candidate) return true;
  }
  return false;
}

function adjustPathAfterRemoval(path: readonly number[], removed: readonly number[]): number[] {
  const depth = removed.length - 1;
  if (depth < 0 || path.length <= depth) return [...path];
  if (!samePath(path.slice(0, depth), removed.slice(0, depth))) return [...path];
  if (path[depth]! <= removed[depth]!) return [...path];
  const copy = [...path];
  copy[depth] = copy[depth]! - 1;
  return copy;
}

function reindent(snippet: string, fromIndent: string, toIndent: string): string {
  if (!fromIndent || fromIndent === toIndent) return snippet;
  const lines = snippet.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(fromIndent)) lines[i] = toIndent + line.slice(fromIndent.length);
  }
  return lines.join('\n');
}

/** 把节点（连同整棵子树）移动到 toParentPath 的第 toIndex 个子节点位置。 */
export function moveNode(
  text: string,
  fromPath: readonly number[],
  toParentPath: readonly number[],
  toIndex: number,
): string {
  const root = rootNode(mapElement(parseXml(text)));
  const from = resolveNode(root, fromPath);
  const toParent = resolveNode(root, toParentPath);
  if (!from) throw new Error('要移动的节点已不存在');
  if (!toParent) throw new Error('目标节点已不存在');
  if (fromPath.length === 0) throw new Error('根节点不能移动');
  if (isAncestorOrSelf(from, toParent)) throw new Error('不能把节点移动到它自己的子树里');

  const fromParentPath = fromPath.slice(0, -1);
  const fromIndex = fromPath[fromPath.length - 1]!;
  let index = toIndex;
  if (samePath(fromParentPath, toParentPath)) {
    if (fromIndex < index) index -= 1;
    if (index === fromIndex) return text;
  }

  const fromIndent = indentAt(text, from.start);
  const raw = text.slice(from.start, from.end);
  const next = removeNode(text, from);

  const root2 = rootNode(mapElement(parseXml(next)));
  const targetPath = adjustPathAfterRemoval(toParentPath, fromPath);
  const parent2 = resolveNode(root2, targetPath);
  if (!parent2) throw new Error('目标位置已失效，请重试');
  const snippet = reindent(raw, fromIndent, childIndentOf(next, parent2));
  return insertChild(next, parent2, index, snippet);
}

export function nodeIdOf(el: XmlElement): string | undefined {
  return attrValue(el, 'ID') || undefined;
}

export function pathOfNode(text: string, target: XmlElement): number[] | null {
  const root = rootNode(mapElement(parseXml(text)));
  return pathOf(root, target);
}
