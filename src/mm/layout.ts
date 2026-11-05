export type Side = 'left' | 'right' | 'root' | 'down';
export type LayoutMode = 'both' | 'down';

/** 布局层只关心几何，不关心文本、XML、DOM —— 这样它能被直接单测。 */
export interface Box {
  w: number;
  h: number;
  x: number;
  y: number;
  side: Side;
  collapsed: boolean;
  subtreeH: number;
  subtreeW: number;
  children: Box[];
}

export const HGAP = 48;
export const VGAP = 10;
/** 上下结构里同级之间的横向间隙 */
export const COL_GAP = 20;

/** w/h 由调用方按文本排好，这里后序算出每棵子树占据的矩形。 */
export function measureBoxes(node: Box): void {
  if (node.collapsed || node.children.length === 0) {
    node.subtreeH = node.h;
    node.subtreeW = node.w;
    return;
  }
  let height = 0;
  let width = 0;
  for (const child of node.children) {
    measureBoxes(child);
    height += child.subtreeH + VGAP;
    width += child.subtreeW + COL_GAP;
  }
  node.subtreeH = Math.max(node.h, height - VGAP);
  node.subtreeW = Math.max(node.w, width - COL_GAP);
}

function blockHeight(nodes: Box[]): number {
  let total = 0;
  for (const node of nodes) total += node.subtreeH + VGAP;
  return nodes.length ? total - VGAP : 0;
}

function blockWidth(nodes: Box[]): number {
  let total = 0;
  for (const node of nodes) total += node.subtreeW + COL_GAP;
  return nodes.length ? total - COL_GAP : 0;
}

function place(node: Box, x: number, top: number): void {
  node.x = x;
  node.y = top + (node.subtreeH - node.h) / 2;
  if (node.collapsed || node.children.length === 0) return;
  const dir = node.side === 'left' ? -1 : 1;
  let y = node.y + node.h / 2 - blockHeight(node.children) / 2;
  for (const child of node.children) {
    child.side = dir === 1 ? 'right' : 'left';
    place(child, dir === 1 ? node.x + node.w + HGAP : node.x - HGAP - child.w, y);
    y += child.subtreeH + VGAP;
  }
}

function placeDown(node: Box, left: number, top: number): void {
  node.y = top;
  node.x = left + (node.subtreeW - node.w) / 2;
  if (node.collapsed || node.children.length === 0) return;
  let x = node.x + node.w / 2 - blockWidth(node.children) / 2;
  const y = node.y + node.h + HGAP;
  for (const child of node.children) {
    child.side = 'down';
    placeDown(child, x, y);
    x += child.subtreeW + COL_GAP;
  }
}

/**
 * 左右分叉时，调用方需要先给根的直接子节点定好 side（POSITION 或自动平衡），
 * 更深的节点由这里按父节点的朝向继承。
 */
export function layoutBoxes(root: Box, mode: LayoutMode): void {
  if (mode === 'down') {
    root.side = 'root';
    placeDown(root, -root.subtreeW / 2, 0);
    return;
  }
  root.side = 'root';
  root.x = 0;
  const left = root.children.filter((c) => c.side === 'left');
  const right = root.children.filter((c) => c.side !== 'left');
  const totalL = blockHeight(left);
  const totalR = blockHeight(right);
  const center = Math.max(totalL, totalR) / 2;
  root.y = center - root.h / 2;

  // 根节点有宽度，一级子节点必须从根的边缘算起，否则会盖在根节点上
  let y = center - totalR / 2;
  for (const child of right) {
    child.side = 'right';
    place(child, root.x + root.w + HGAP, y);
    y += child.subtreeH + VGAP;
  }
  y = center - totalL / 2;
  for (const child of left) {
    child.side = 'left';
    place(child, root.x - HGAP - child.w, y);
    y += child.subtreeH + VGAP;
  }
}
