import { randomBytes } from 'node:crypto';
import { childNodes, mapElement, parseXml, resolveNode, rootNode } from './parse.ts';
import { insertChild, moveNode, removeNode, setNodeText } from './patch.ts';

export type MindMapOp =
  | { type: 'setText'; path: number[]; text: string }
  | { type: 'addChild'; path: number[] }
  | { type: 'addSibling'; path: number[]; before?: boolean }
  | { type: 'remove'; path: number[] }
  | { type: 'paste'; path: number[]; xml: string }
  | { type: 'move'; from: number[]; parent: number[]; index: number };

export interface OpResult {
  text: string;
  /** 新建节点后进入编辑 */
  editPath?: number[];
  /** 删除节点后改为选中父节点 */
  selectPath?: number[];
}

function must<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function newNodeXml(): { xml: string; id: string } {
  const id = randomBytes(6).toString('hex');
  return { xml: `<node TEXT="新节点" ID="${id}"/>`, id };
}

export function applyOp(text: string, op: MindMapOp): OpResult {
  const root = rootNode(mapElement(parseXml(text)));

  switch (op.type) {
    case 'setText': {
      const el = must(resolveNode(root, op.path), '节点已不存在');
      return { text: setNodeText(text, el, op.text) };
    }
    case 'addChild': {
      const parent = must(resolveNode(root, op.path), '父节点已不存在');
      const index = childNodes(parent).length;
      const { xml } = newNodeXml();
      return { text: insertChild(text, parent, index, xml), editPath: [...op.path, index] };
    }
    case 'addSibling': {
      if (op.path.length === 0) throw new Error('根节点不能有同级');
      const parentPath = op.path.slice(0, -1);
      const parent = must(resolveNode(root, parentPath), '父节点已不存在');
      const index = op.path[op.path.length - 1]! + (op.before ? 0 : 1);
      const { xml } = newNodeXml();
      return { text: insertChild(text, parent, index, xml), editPath: [...parentPath, index] };
    }
    case 'remove': {
      if (op.path.length === 0) throw new Error('根节点不能删除');
      const el = must(resolveNode(root, op.path), '节点已不存在');
      return { text: removeNode(text, el), selectPath: op.path.slice(0, -1) };
    }
    case 'paste': {
      const parent = must(resolveNode(root, op.path), '目标节点已不存在');
      const xml = op.xml.trim();
      if (!/^<node[\s>]/.test(xml)) throw new Error('剪贴板里没有可粘贴的节点');
      // 重新分配 ID，避免同一文件里出现重复 ID
      const cleaned = xml.replace(/ID\s*=\s*"[^"]*"/g, () => `ID="${randomBytes(6).toString('hex')}"`);
      const index = childNodes(parent).length;
      const next = insertChild(text, parent, index, cleaned);
      rootNode(mapElement(parseXml(next)));
      return { text: next, selectPath: [...op.path, index] };
    }
    case 'move': {
      return { text: moveNode(text, op.from, op.parent, op.index) };
    }
  }
}
