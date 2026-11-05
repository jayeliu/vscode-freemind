/**
 * 容错但不失真的 FreeMind XML 解析器。
 * 只为「定位 + 原样透传」服务：每个元素都带原始 offset，序列化时不需要重建整份文档。
 */

export class XmlError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'XmlError';
    this.position = position;
  }
}

export interface XmlAttr {
  name: string;
  quote: string;
  /** 原始（未解码）属性值 */
  value: string;
  /** 引号内文本的起始下标 */
  valueStart: number;
  /** 结束引号的下标 */
  valueEnd: number;
}

export interface XmlElement {
  kind: 'element';
  name: string;
  /** '<' 的下标 */
  start: number;
  /** '>' 之后的下标 */
  openEnd: number;
  /** '</' 的下标；自闭合时等于 end */
  closeStart: number;
  /** 元素结束（'>' 之后）的下标 */
  end: number;
  selfClosing: boolean;
  attrs: XmlAttr[];
  children: XmlElement[];
  parent: XmlElement | null;
}

const NAME_RE = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const WS_RE = /\s/;

export function parseXml(text: string): XmlElement {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = text.length;

  const fail = (message: string, at: number): never => {
    const lineStart = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
    const line = text.slice(0, at).split('\n').length;
    throw new XmlError(`${message}（第 ${line} 行第 ${at - lineStart + 1} 列）`, at);
  };

  const skipWs = (): void => {
    while (pos < len && WS_RE.test(text[pos]!)) pos++;
  };

  const skipUntil = (needle: string, what: string, from: number): void => {
    const at = text.indexOf(needle, from);
    if (at < 0) fail(`${what}未闭合`, from);
    pos = at + needle.length;
  };

  const skipMisc = (): void => {
    for (;;) {
      skipWs();
      if (text.startsWith('<?', pos)) {
        skipUntil('?>', '处理指令', pos + 2);
        continue;
      }
      if (text.startsWith('<!--', pos)) {
        skipUntil('-->', '注释', pos + 4);
        continue;
      }
      if (text.startsWith('<!DOCTYPE', pos) || text.startsWith('<!doctype', pos)) {
        skipUntil('>', 'DOCTYPE', pos + 9);
        continue;
      }
      break;
    }
  };

  const readName = (): string => {
    NAME_RE.lastIndex = pos;
    const m = NAME_RE.exec(text);
    if (!m) fail('缺少元素名', pos);
    pos += m![0].length;
    return m![0];
  };

  const parseElement = (parent: XmlElement | null): XmlElement => {
    const start = pos;
    pos++; // '<'
    const name = readName();
    const el: XmlElement = {
      kind: 'element',
      name,
      start,
      openEnd: start,
      closeStart: start,
      end: start,
      selfClosing: false,
      attrs: [],
      children: [],
      parent,
    };

    for (;;) {
      skipWs();
      if (pos >= len) fail(`<${name}> 未闭合`, start);
      const ch = text[pos]!;
      if (ch === '/') {
        if (text[pos + 1] !== '>') fail('自闭合标签格式错误', pos);
        pos += 2;
        el.selfClosing = true;
        el.openEnd = el.closeStart = el.end = pos;
        return el;
      }
      if (ch === '>') {
        pos++;
        el.openEnd = pos;
        break;
      }
      const attrName = readName();
      skipWs();
      if (text[pos] !== '=') fail(`属性 ${attrName} 缺少 =`, pos);
      pos++;
      skipWs();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") fail(`属性 ${attrName} 的值必须用引号包裹`, pos);
      const valueStart = pos + 1;
      const valueEnd = text.indexOf(quote!, valueStart);
      if (valueEnd < 0) fail(`属性 ${attrName} 的引号未闭合`, valueStart);
      el.attrs.push({ name: attrName, quote: quote!, value: text.slice(valueStart, valueEnd), valueStart, valueEnd });
      pos = valueEnd + 1;
    }

    for (;;) {
      if (pos >= len) fail(`<${name}> 未闭合`, start);
      if (text[pos] === '<') {
        if (text.startsWith('<!--', pos)) {
          skipUntil('-->', '注释', pos + 4);
          continue;
        }
        if (text.startsWith('<![CDATA[', pos)) {
          skipUntil(']]>', 'CDATA', pos + 9);
          continue;
        }
        if (text.startsWith('<?', pos)) {
          skipUntil('?>', '处理指令', pos + 2);
          continue;
        }
        if (text.startsWith('</', pos)) {
          const closeStart = pos;
          pos += 2;
          const closeName = readName();
          skipWs();
          if (text[pos] !== '>') fail(`结束标签 </${closeName}> 格式错误`, pos);
          pos++;
          if (closeName !== name) fail(`结束标签 </${closeName}> 与 <${name}> 不匹配`, closeStart);
          el.closeStart = closeStart;
          el.end = pos;
          return el;
        }
        if (text.startsWith('<!', pos)) {
          skipUntil('>', '声明', pos + 2);
          continue;
        }
        el.children.push(parseElement(el));
        continue;
      }
      const next = text.indexOf('<', pos);
      pos = next < 0 ? len : next;
    }
  };

  skipMisc();
  if (pos >= len) fail('文件为空，未找到根元素', pos);
  if (text[pos] !== '<') fail('根元素之前存在文本', pos);
  const root = parseElement(null);
  skipMisc();
  if (pos < len) fail('根元素之后存在多余内容', pos);
  return root;
}

export function childNodes(el: XmlElement): XmlElement[] {
  return el.children.filter((c) => c.name === 'node');
}

export function findAttr(el: XmlElement, name: string): XmlAttr | undefined {
  return el.attrs.find((a) => a.name === name);
}

export function attrValue(el: XmlElement, name: string): string | undefined {
  const attr = findAttr(el, name);
  return attr ? decodeEntities(attr.value) : undefined;
}

export function mapElement(root: XmlElement): XmlElement {
  if (root.name === 'map') return root;
  const found = findElement(root, 'map');
  if (!found) throw new XmlError('不是 FreeMind 思维导图：缺少 <map> 根元素', root.start);
  return found;
}

function findElement(el: XmlElement, name: string): XmlElement | undefined {
  for (const child of el.children) {
    if (child.name === name) return child;
    const nested = findElement(child, name);
    if (nested) return nested;
  }
  return undefined;
}

export function rootNode(map: XmlElement): XmlElement {
  const node = map.children.find((c) => c.name === 'node');
  if (!node) throw new XmlError('思维导图为空：<map> 下没有 <node>', map.start);
  return node;
}

export function resolveNode(root: XmlElement, path: readonly number[]): XmlElement | null {
  let cur: XmlElement = root;
  for (const idx of path) {
    const next = childNodes(cur)[idx];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** 节点显示文本：优先 TEXT，其次 richcontent(TYPE=NODE)。 */
export function nodeText(text: string, el: XmlElement): string {
  const attr = findAttr(el, 'TEXT');
  if (attr) return decodeEntities(attr.value);
  const html = richHtml(text, el, 'NODE');
  return html ? stripHtml(html) : '';
}

export function richHtml(text: string, el: XmlElement, type: 'NODE' | 'NOTE'): string | undefined {
  for (const child of el.children) {
    if (child.name !== 'richcontent') continue;
    const kind = (attrValue(child, 'TYPE') ?? 'NODE').toUpperCase();
    if (kind !== type) continue;
    const htmlEl = child.children.find((c) => c.name === 'html');
    if (!htmlEl) continue;
    return text.slice(htmlEl.openEnd, htmlEl.closeStart);
  }
  return undefined;
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}
