import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutBoxes, measureBoxes, type Box, type LayoutMode } from '../src/mm/layout.ts';

let seed = 20261105;

function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

interface Spec {
  w?: number;
  h?: number;
  collapsed?: boolean;
  children?: Spec[];
}

function box(spec: Spec = {}): Box {
  return {
    w: spec.w ?? 56,
    h: spec.h ?? 30,
    x: 0,
    y: 0,
    side: 'root',
    collapsed: spec.collapsed ?? false,
    subtreeH: 0,
    subtreeW: 0,
    children: (spec.children ?? []).map(box),
  };
}

/** 随机树：宽度、行数、分支、折叠都随机，用来撞布局的边角 */
function randomTree(depth: number): Box {
  const node = box({
    w: 56 + Math.floor(rnd() * 184),
    h: 30 + Math.floor(rnd() * 90),
    collapsed: rnd() < 0.08,
  });
  if (depth > 0) {
    const count = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < count; i++) node.children.push(randomTree(depth - 1));
  }
  return node;
}

/** 和 webview 一样：先按子树高度给根的一级子节点分配左右 */
function arrange(root: Box, mode: LayoutMode): void {
  measureBoxes(root);
  if (mode === 'both') {
    let leftH = 0;
    let rightH = 0;
    for (const child of root.children) {
      const side = rightH <= leftH ? 'right' : 'left';
      child.side = side;
      if (side === 'left') leftH += child.subtreeH;
      else rightH += child.subtreeH;
    }
  }
  layoutBoxes(root, mode);
}

function visible(root: Box): Box[] {
  const out: Box[] = [];
  const walk = (node: Box): void => {
    out.push(node);
    if (!node.collapsed) for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function overlaps(a: Box, b: Box): boolean {
  const eps = 0.01;
  return a.x + eps < b.x + b.w && b.x + eps < a.x + a.w && a.y + eps < b.y + b.h && b.y + eps < a.y + a.h;
}

function assertNoOverlap(root: Box, label: string): void {
  const nodes = visible(root);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      assert.ok(
        !overlaps(a, b),
        `${label}：节点重叠 (${a.x.toFixed(1)},${a.y.toFixed(1)},${a.w}×${a.h}) 与 (${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w}×${b.h})`,
      );
    }
  }
}

test('宽根节点不会盖住一级子节点', () => {
  const root = box({ w: 240, h: 60, children: [{ w: 200, h: 40 }, { w: 200, h: 40 }] });
  arrange(root, 'both');
  const right = root.children.find((c) => c.side === 'right');
  const left = root.children.find((c) => c.side === 'left');
  assert.ok(right && left);
  assert.ok(right.x >= root.x + root.w, '右侧一级子节点必须从根的右边缘之外开始');
  assert.ok(left.x + left.w <= root.x, '左侧一级子节点必须在根的左边缘之外');
  assertNoOverlap(root, '两者都有');
});

test('左右分叉随机树无重叠', () => {
  for (let i = 0; i < 200; i++) {
    const root = randomTree(4);
    arrange(root, 'both');
    assertNoOverlap(root, `左右 #${i}`);
  }
});

test('上下结构随机树无重叠', () => {
  for (let i = 0; i < 200; i++) {
    const root = randomTree(4);
    arrange(root, 'down');
    assertNoOverlap(root, `上下 #${i}`);
  }
});

test('折叠子树不参与布局宽度', () => {
  const root = box({ w: 100, h: 40, children: [{ w: 100, h: 40, collapsed: true, children: [{ w: 240, h: 120 }] }] });
  arrange(root, 'down');
  const child = root.children[0]!;
  assert.equal(child.subtreeW, child.w);
  assert.equal(child.subtreeH, child.h);
  assertNoOverlap(root, '折叠');
});
