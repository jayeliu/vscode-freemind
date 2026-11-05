import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseXml, mapElement, rootNode, resolveNode, nodeText, childNodes, attrValue, XmlError } from '../src/mm/parse.ts';
import { minimalPatch, setNodeText, escapeAttr } from '../src/mm/patch.ts';
import { applyOp } from '../src/mm/ops.ts';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.0.1">
<!-- 保留注释 -->
<node TEXT="根 &amp; 节点" ID="aaa">
  <node TEXT="子一" ID="b1" STYLE="bubble" POSITION="right" custom="x">
    <richcontent TYPE="NOTE"><html><body><p>备注</p></body></html></richcontent>
    <icon BUILTIN="idea"/>
    <node TEXT="孙" ID="c1"/>
  </node>
  <node TEXT="子二" ID="b2"/>
</node>
</map>
`;

function root(text: string) {
  return rootNode(mapElement(parseXml(text)));
}

function countNodes(text: string): number {
  let total = 0;
  const walk = (el: ReturnType<typeof root>): void => {
    for (const child of childNodes(el)) {
      total++;
      walk(child);
    }
  };
  walk(root(text));
  return total;
}

function assertPatchReproduces(before: string, after: string): void {
  const patch = minimalPatch(before, after);
  assert.ok(patch, '应该产生补丁');
  assert.equal(before.slice(0, patch.start) + patch.text + before.slice(patch.end), after);
}

test('解析带声明、注释、实体和未知属性的文件', () => {
  assert.equal(mapElement(parseXml(SAMPLE)).name, 'map');
  const el = root(SAMPLE);
  assert.equal(el.name, 'node');
  const first = resolveNode(el, [0]);
  assert.ok(first);
  assert.equal(nodeText(SAMPLE, first), '子一');
  assert.equal(nodeText(SAMPLE, el), '根 & 节点');
});

test('未编辑时文本完全不变', () => {
  // 解析器不产出文本，唯一保证就是所有操作都基于原文切片
  const before = SAMPLE;
  const patch = minimalPatch(before, before);
  assert.equal(patch, null);
});

test('改一个节点文本只替换该属性值', () => {
  const el = resolveNode(root(SAMPLE), [0]);
  assert.ok(el);
  const after = setNodeText(SAMPLE, el, '改 & 了');
  assert.ok(after.includes('TEXT="改 &amp; 了"'));
  assertPatchReproduces(SAMPLE, after);
  const patch = minimalPatch(SAMPLE, after)!;
  assert.equal(SAMPLE.slice(patch.start, patch.end), '子一');
  assert.equal(countNodes(after), countNodes(SAMPLE));
});

test('其它属性、注释、icon 原样保留', () => {
  const el = resolveNode(root(SAMPLE), [0]);
  assert.ok(el);
  const after = setNodeText(SAMPLE, el, '新');
  assert.ok(after.includes('STYLE="bubble" POSITION="right" custom="x"'));
  assert.ok(after.includes('<icon BUILTIN="idea"/>'));
  assert.ok(after.includes('<!-- 保留注释 -->'));
});

test('编辑 richcontent 节点会移除旧 HTML（已知有损点）', () => {
  const text = '<map><node TEXT="a" ID="1"><node ID="2"><richcontent TYPE="NODE"><html><body><p>hi</p></body></html></richcontent></node></node></map>';
  const el = resolveNode(root(text), [0]);
  assert.ok(el);
  const after = setNodeText(text, el, '纯文本');
  assert.ok(!after.includes('richcontent'));
  assert.ok(after.includes('node TEXT="纯文本" ID="2"'));
});

test('转义：引号、换行、制表', () => {
  assert.equal(escapeAttr('a"b&c<d>e\nf\tg'), 'a&quot;b&amp;c&lt;d&gt;e&#10;f&#9;g');
});

test('新增子节点：自闭合父节点被展开', () => {
  const text = '<map version="1.0.1"><node TEXT="r" ID="r"/></map>';
  const out = applyOp(text, { type: 'addChild', path: [] });
  assert.match(out.text, /^<map version="1\.0\.1"><node TEXT="r" ID="r"><node TEXT="新节点" ID="[0-9a-f]{12}"\/><\/node><\/map>$/);
  assert.deepEqual(out.editPath, [0]);
  assert.equal(countNodes(out.text), 1);
});

test('新增子节点：缩进与已有兄弟一致', () => {
  const out = applyOp(SAMPLE, { type: 'addChild', path: [0] });
  const lines = out.text.split('\n');
  const added = lines.filter((line) => line.includes('新节点'));
  assert.equal(added.length, 1);
  assert.match(added[0]!, /^ {4}<node TEXT="新节点" ID="[0-9a-f]{12}"\/>$/);
  assert.equal(countNodes(out.text), countNodes(SAMPLE) + 1);
  assert.equal(nodeText(out.text, resolveNode(root(out.text), [0, 1])!), '新节点');
  assert.deepEqual(out.editPath, [0, 1]);
});

test('新增同级节点 before / after', () => {
  const after = applyOp(SAMPLE, { type: 'addSibling', path: [0] });
  assert.equal(nodeText(after.text, resolveNode(root(after.text), [1])!), '新节点');
  assert.equal(nodeText(after.text, resolveNode(root(after.text), [0])!), '子一');
  assert.deepEqual(after.editPath, [1]);

  const before = applyOp(SAMPLE, { type: 'addSibling', path: [0], before: true });
  assert.equal(nodeText(before.text, resolveNode(root(before.text), [0])!), '新节点');
  assert.equal(nodeText(before.text, resolveNode(root(before.text), [1])!), '子一');
});

test('删除子树后父节点仍在', () => {
  const out = applyOp(SAMPLE, { type: 'remove', path: [1] });
  assert.equal(countNodes(out.text), countNodes(SAMPLE) - 1);
  assert.equal(nodeText(out.text, resolveNode(root(out.text), [0])!), '子一');
  assert.deepEqual(out.selectPath, []);
  assert.ok(!out.text.includes('子二'));
  assert.ok(out.text.includes('<node TEXT="孙" ID="c1"/>'));
});

test('根节点不能删除、不能有同级、不能移动', () => {
  assert.throws(() => applyOp(SAMPLE, { type: 'remove', path: [] }), /根节点/);
  assert.throws(() => applyOp(SAMPLE, { type: 'addSibling', path: [] }), /根节点/);
  assert.throws(() => applyOp(SAMPLE, { type: 'move', from: [], parent: [0], index: 0 }), /根节点/);
});

test('移动节点到另一父节点，子树一起搬走', () => {
  const out = applyOp(SAMPLE, { type: 'move', from: [0], parent: [1], index: 0 });
  const r = root(out.text);
  const b2 = resolveNode(r, [0]);
  const b1 = resolveNode(r, [0, 0]);
  assert.ok(b2 && b1);
  assert.equal(nodeText(out.text, b2), '子二');
  assert.equal(nodeText(out.text, b1), '子一');
  assert.equal(nodeText(out.text, resolveNode(r, [0, 0, 0])!), '孙');
  assert.ok(out.text.includes('<icon BUILTIN="idea"/>'));
});

test('同父重排', () => {
  const text = '<map>\n  <node TEXT="r" ID="r">\n    <node TEXT="a" ID="a"/>\n    <node TEXT="b" ID="b"/>\n    <node TEXT="c" ID="c"/>\n  </node>\n</map>\n';
  const out = applyOp(text, { type: 'move', from: [0], parent: [], index: 2 });
  const r = root(out.text);
  const names = [0, 1, 2].map((i) => nodeText(out.text, resolveNode(r, [i])!));  assert.deepEqual(names, ['b', 'a', 'c']);
  assert.ok(out.text.includes('<node TEXT="c" ID="c"/>'));
});

test('移动到自己子树里被拒绝', () => {
  const text = '<map><node TEXT="r" ID="r"><node TEXT="a" ID="a"><node TEXT="b" ID="b"/></node></node></map>';
  assert.throws(() => applyOp(text, { type: 'move', from: [0], parent: [0, 0], index: 0 }), /子树/);
});

test('非法 XML 抛出带位置信息的错误', () => {
  assert.throws(() => parseXml('<map><node TEXT="a"></map>'), (error: unknown) => {
    assert.ok(error instanceof XmlError);
    assert.match((error as Error).message, /第 \d+ 行第 \d+ 列/);
    return true;
  });
});

const FIXTURE = join(import.meta.dirname, 'fixtures', 'notebook.mm');

test('示例文件存在（缺失时别静默跳过）', () => {
  assert.ok(existsSync(FIXTURE), FIXTURE);
});

test('示例文件：节点数正确，改文本后结构不变', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const total = countNodes(text);
  assert.ok(total >= 40, `示例节点数 ${total}`);

  const target = resolveNode(root(text), [0, 0]);
  assert.ok(target);
  const after = setNodeText(text, target, '改写后的文本');
  assert.equal(countNodes(after), total);
  assertPatchReproduces(text, after);
  // 除了一处 TEXT 值，文件其余部分字节相同
  const patch = minimalPatch(text, after)!;
  assert.ok(patch.end - patch.start < 40);
});

test('示例文件：零宽字符、尾随空格、换行实体原样读出', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const pick = (id: string): string => {
    let hit = '';
    const walk = (el: ReturnType<typeof root>): void => {
      if (attrValue(el, 'ID') === id) hit = nodeText(text, el);
      else childNodes(el).forEach(walk);
    };
    walk(root(text));
    return hit;
  };
  assert.equal(pick('ID_zw'), '待办\u200B  ');
  assert.equal(pick('ID_nl'), '复盘 \n每周五');
  assert.equal(pick('ID_amp'), 'A & B < C');
  assert.equal(pick('ID_es'), 'Elasticsearch');
});
