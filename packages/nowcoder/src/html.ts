export interface HtmlText {
  type: "text";
  value: string;
  parent: HtmlElement;
}

export interface HtmlElement {
  type: "element";
  tagName: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
  parent?: HtmlElement;
}

export type HtmlNode = HtmlElement | HtmlText;

export interface HtmlParserLimits {
  maxInputChars: number;
  maxNodes: number;
  maxDepth: number;
  maxTextChars: number;
}

export class HtmlParseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlParseLimitError";
  }
}

const DEFAULT_LIMITS: HtmlParserLimits = {
  maxInputChars: 2 * 1024 * 1024,
  maxNodes: 50_000,
  maxDepth: 256,
  maxTextChars: 2 * 1024 * 1024
};

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea"]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export function parseHtmlDocument(html: string, limits: HtmlParserLimits = DEFAULT_LIMITS): HtmlElement {
  if (html.length > limits.maxInputChars) throw new HtmlParseLimitError("HTML input limit exceeded.");
  const root: HtmlElement = { type: "element", tagName: "#document", attributes: {}, children: [] };
  const stack = [root];
  const lowerHtml = html.toLowerCase();
  let nodeCount = 1;
  let textChars = 0;
  let offset = 0;

  const addNode = (): void => {
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) throw new HtmlParseLimitError("HTML node limit exceeded.");
  };
  const addText = (parent: HtmlElement, value: string): void => {
    if (!value) return;
    textChars += value.length;
    if (textChars > limits.maxTextChars) throw new HtmlParseLimitError("HTML text limit exceeded.");
    addNode();
    parent.children.push({ type: "text", value, parent });
  };

  while (offset < html.length) {
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      offset = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[offset] !== "<") {
      const end = html.indexOf("<", offset);
      addText(stack.at(-1)!, html.slice(offset, end === -1 ? html.length : end));
      offset = end === -1 ? html.length : end;
      continue;
    }
    if (/^<![^-]/.test(html.slice(offset, offset + 4)) || html.startsWith("<?", offset)) {
      const end = findTagEnd(html, offset + 2);
      offset = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = findTagEnd(html, offset + 1);
    if (end === -1) {
      addText(stack.at(-1)!, html.slice(offset));
      break;
    }
    const token = html.slice(offset + 1, end);
    if (token.startsWith("/")) {
      closeElement(stack, token.slice(1).trim().split(/\s/, 1)[0]?.toLowerCase() ?? "");
      offset = end + 1;
      continue;
    }

    const parsed = parseOpeningTag(token);
    if (!parsed) {
      addText(stack.at(-1)!, "<");
      offset += 1;
      continue;
    }
    const parent = stack.at(-1)!;
    const element: HtmlElement = { type: "element", tagName: parsed.tagName, attributes: parsed.attributes, children: [], parent };
    addNode();
    parent.children.push(element);
    offset = end + 1;

    if (parsed.selfClosing || VOID_ELEMENTS.has(element.tagName)) {
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(element.tagName)) {
      const closeStart = lowerHtml.indexOf(`</${element.tagName}`, offset);
      if (closeStart === -1) {
        addText(element, html.slice(offset));
        break;
      }
      addText(element, html.slice(offset, closeStart));
      const closeEnd = findTagEnd(html, closeStart + 2);
      offset = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (stack.length > limits.maxDepth) throw new HtmlParseLimitError("HTML depth limit exceeded.");
    stack.push(element);
  }

  return root;
}

export function findElements(root: HtmlElement, predicate: (element: HtmlElement) => boolean): HtmlElement[] {
  const result: HtmlElement[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (predicate(element)) result.push(element);
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (child?.type === "element") stack.push(child);
    }
  }
  return result;
}

export function findFirst(root: HtmlElement, predicate: (element: HtmlElement) => boolean): HtmlElement | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (predicate(element)) return element;
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (child?.type === "element") stack.push(child);
    }
  }
  return undefined;
}

export function hasClass(element: HtmlElement, className: string): boolean {
  return (element.attributes.class ?? "").split(/\s+/).includes(className);
}

export function isWithinClass(element: HtmlElement, className: string): boolean {
  let parent = element.parent;
  while (parent) {
    if (hasClass(parent, className)) return true;
    parent = parent.parent;
  }
  return false;
}

export function rawText(element: HtmlElement): string {
  const parts: string[] = [];
  const stack = [...element.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "text") {
      parts.push(decodeEntities(node.value));
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return parts.join("");
}

export function renderText(element: HtmlElement): string {
  return normalizeRenderedText(renderNodes(element, true));
}

export function sampleText(element: HtmlElement): string {
  return renderNodes(element, false).replace(/\r\n?/g, "\n");
}

function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseOpeningTag(token: string): { tagName: string; attributes: Record<string, string>; selfClosing: boolean } | undefined {
  const match = /^\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(token);
  if (!match) return undefined;
  const tagName = match[1].toLowerCase();
  const attributes: Record<string, string> = {};
  const source = token.slice(match[0].length).replace(/\/\s*$/, "");
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const attribute of source.matchAll(attributePattern)) {
    attributes[attribute[1].toLowerCase()] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
  }
  return { tagName, attributes, selfClosing: /\/\s*$/.test(token) };
}

function closeElement(stack: HtmlElement[], tagName: string): void {
  // This bounded page parser accepts balanced markup and ignores a non-top close.
  // It deliberately does not search ancestors, keeping malformed input linear.
  if (stack.length > 1 && stack[stack.length - 1]?.tagName === tagName) stack.pop();
}

function renderNodes(element: HtmlElement, formatBlocks: boolean): string {
  const parts: string[] = [];
  const stack: Array<{ node: HtmlNode; closing?: boolean }> = [{ node: element }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    if (node.type === "text") {
      parts.push(decodeEntities(node.value));
      continue;
    }
    if (frame.closing) {
      if (formatBlocks && BLOCK_ELEMENTS.has(node.tagName)) parts.push("\n");
      continue;
    }
    if (node.tagName === "script" || node.tagName === "style") continue;
    if (node.tagName === "br") {
      parts.push("\n");
      continue;
    }
    if (node.tagName === "img") {
      parts.push(renderImage(node));
      continue;
    }
    const block = formatBlocks && BLOCK_ELEMENTS.has(node.tagName);
    if (block) parts.push("\n");
    stack.push({ node, closing: true });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index]! });
    }
  }
  return parts.join("");
}

function renderImage(element: HtmlElement): string {
  const source = element.attributes.src;
  if (source) {
    try {
      const url = new URL(source, "https://ac.nowcoder.com");
      if ((url.hostname === "www.nowcoder.com" || url.hostname === "ac.nowcoder.com") && url.pathname === "/equation") {
        const tex = url.searchParams.get("tex");
        if (tex) return `$${tex}$`;
      }
    } catch {
      // Fall through to accessible text for malformed image URLs.
    }
  }
  return element.attributes.alt ?? "";
}

function normalizeRenderedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"' };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith("#")) {
      const hexadecimal = key[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return named[key.toLowerCase()] ?? entity;
  });
}
