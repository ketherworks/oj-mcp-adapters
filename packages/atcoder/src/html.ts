import { defaultTreeAdapter, parse, type DefaultTreeAdapterTypes } from "parse5";
import { SAXParser, type Text } from "parse5-sax-parser";

export interface HtmlText {
  type: "text";
  value: string;
}

export interface HtmlElement {
  type: "element";
  name: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlText | HtmlElement;

export interface HtmlParseLimits {
  maxNodes: number;
  maxDepth: number;
  maxTextChars: number;
  maxTextBytes?: number;
}

export interface HtmlPreflightResult {
  scannedChars: number;
  potentialNodes: number;
  maxDepth: number;
  textBytes: number;
}

export interface SanitizedHtml {
  html: string;
  text: string;
}

export class HtmlLimitError extends Error {
  constructor(message: string, readonly scannedChars?: number) {
    super(message);
    this.name = "HtmlLimitError";
  }
}

export const DEFAULT_HTML_LIMITS: Readonly<HtmlParseLimits> = {
  maxNodes: 25_000,
  maxDepth: 256,
  maxTextChars: 1_500_000,
  maxTextBytes: 1_500_000
};

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK_ELEMENTS = new Set(["address", "article", "blockquote", "div", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul"]);
const SAFE_ELEMENTS = new Set(["a", "b", "blockquote", "br", "code", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "h4", "h5", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul", "var"]);
const DROP_WITH_CONTENT = new Set(["button", "embed", "form", "iframe", "input", "noscript", "object", "script", "style", "template"]);
const PREFLIGHT_IMPLICIT_NODES = 4;
const PREFLIGHT_IMPLICIT_DEPTH = 2;
const PREFLIGHT_TABLE_WRAPPER_DEPTH = 2;
// HTML5 error recovery can reconstruct several elements from one malformed markup token.
const PREFLIGHT_TAG_NODE_COST = 32;
const PREFLIGHT_CHUNK_CHARS = 16 * 1024;

export function parseHtml(source: string, limits: HtmlParseLimits = DEFAULT_HTML_LIMITS): HtmlElement {
  preflightHtml(source, limits);
  const parsed = parse(source);
  const root: HtmlElement = { type: "element", name: "#document", attributes: {}, children: [] };
  const stack: Array<{ source: ParseParent; target: HtmlElement; depth: number }> = [
    { source: parsed, target: root, depth: 0 }
  ];
  let nodeCount = 0;
  let textChars = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = parseChildren(frame.source);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (!defaultTreeAdapter.isElementNode(child) && !defaultTreeAdapter.isTextNode(child)) continue;
      nodeCount += 1;
      if (nodeCount > limits.maxNodes) throw new HtmlLimitError("HTML exceeded the node limit.");
      if (defaultTreeAdapter.isTextNode(child)) {
        textChars += child.value.length;
        if (textChars > limits.maxTextChars) throw new HtmlLimitError("HTML exceeded the decoded text limit.");
        frame.target.children.unshift({ type: "text", value: child.value });
        continue;
      }

      const depth = frame.depth + 1;
      if (depth > limits.maxDepth) throw new HtmlLimitError("HTML exceeded the element depth limit.");
      const element: HtmlElement = {
        type: "element",
        name: child.tagName.toLowerCase(),
        attributes: Object.fromEntries(child.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value])),
        children: []
      };
      frame.target.children.unshift(element);
      stack.push({ source: child, target: element, depth });
    }
  }

  return root;
}

export function preflightHtml(source: string, limits: HtmlParseLimits = DEFAULT_HTML_LIMITS): HtmlPreflightResult {
  validateLimits(limits);
  const maximumTextBytes = limits.maxTextBytes ?? limits.maxTextChars;
  const openElements: Array<{ name: string; depthCost: number }> = [];
  const openElementCounts = new Map<string, number>();
  const parser = new SAXParser();
  let scannedChars = 0;
  let potentialNodes = PREFLIGHT_IMPLICIT_NODES;
  let depth = PREFLIGHT_IMPLICIT_DEPTH;
  let maximumDepth = PREFLIGHT_IMPLICIT_DEPTH;
  let textChars = 0;
  let textBytes = 0;

  if (depth > limits.maxDepth) {
    throw new HtmlLimitError("HTML preflight exceeded the nesting depth limit.", scannedChars);
  }
  if (potentialNodes > limits.maxNodes) {
    throw new HtmlLimitError("HTML preflight exceeded the potential node limit.", scannedChars);
  }

  const addPotentialNodes = (amount: number) => {
    potentialNodes += amount;
    if (potentialNodes > limits.maxNodes) {
      parser.stop();
      throw new HtmlLimitError("HTML preflight exceeded the potential node limit.", scannedChars);
    }
  };

  parser.on("startTag", ({ tagName }) => {
    addPotentialNodes(PREFLIGHT_TAG_NODE_COST + (tagName === "table" ? PREFLIGHT_TABLE_WRAPPER_DEPTH : 0));
    if (VOID_ELEMENTS.has(tagName)) return;

    const depthCost = preflightElementDepthCost(tagName);
    depth += depthCost;
    if (depth > limits.maxDepth || openElements.length >= limits.maxDepth) {
      parser.stop();
      throw new HtmlLimitError("HTML preflight exceeded the nesting depth limit.", scannedChars);
    }
    maximumDepth = Math.max(maximumDepth, depth);
    openElements.push({ name: tagName, depthCost });
    openElementCounts.set(tagName, (openElementCounts.get(tagName) ?? 0) + 1);
  });

  parser.on("endTag", ({ tagName }) => {
    addPotentialNodes(PREFLIGHT_TAG_NODE_COST);
    const current = openElements.at(-1);
    if (current?.name === tagName) {
      openElements.pop();
      depth -= current.depthCost;
      const remaining = openElementCounts.get(tagName)! - 1;
      if (remaining === 0) openElementCounts.delete(tagName);
      else openElementCounts.set(tagName, remaining);
      return;
    }

    if (openElementCounts.has(tagName)) {
      parser.stop();
      throw new HtmlLimitError("HTML preflight could not safely resolve malformed element nesting.", scannedChars);
    }
  });

  parser.on("text", ({ text }: Text) => {
    if (text.length === 0) return;
    addPotentialNodes(1);
    textChars += text.length;
    if (textChars > limits.maxTextChars) {
      parser.stop();
      throw new HtmlLimitError("HTML preflight exceeded the decoded text limit.", scannedChars);
    }
    textBytes += utf8ByteLength(text);
    if (textBytes > maximumTextBytes) {
      parser.stop();
      throw new HtmlLimitError("HTML preflight exceeded the text byte limit.", scannedChars);
    }
  });

  parser.on("comment", () => addPotentialNodes(PREFLIGHT_TAG_NODE_COST));
  parser.on("doctype", () => addPotentialNodes(PREFLIGHT_TAG_NODE_COST));

  while (scannedChars < source.length) {
    const start = scannedChars;
    scannedChars = Math.min(source.length, start + PREFLIGHT_CHUNK_CHARS);
    parser.write(source.slice(start, scannedChars));
  }
  parser.end();

  return { scannedChars, potentialNodes, maxDepth: maximumDepth, textBytes };
}

export function findFirst(root: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement | undefined {
  const stack: HtmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    if (predicate(node)) return node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return undefined;
}

export function findAll(root: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement[] {
  const matches: HtmlElement[] = [];
  const stack: HtmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    if (predicate(node)) matches.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return matches;
}

export function hasClass(element: HtmlElement, className: string): boolean {
  return (element.attributes.class ?? "").split(/\s+/).includes(className);
}

export function plainText(root: HtmlNode | HtmlNode[]): string {
  const roots = Array.isArray(root) ? root : [root];
  const chunks: string[] = [];
  const stack: RenderFrame[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ node: roots[index]!, closing: false });
  while (stack.length > 0) {
    const { node, closing } = stack.pop()!;
    if (node.type === "text") {
      chunks.push(node.value);
      continue;
    }
    if (node.name === "br") {
      chunks.push("\n");
      continue;
    }
    if (closing) {
      if (BLOCK_ELEMENTS.has(node.name)) chunks.push("\n");
      continue;
    }
    if (BLOCK_ELEMENTS.has(node.name)) chunks.push("\n");
    stack.push({ node, closing: true });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index]!, closing: false });
    }
  }
  return normalizeRenderedText(chunks.join(""));
}

export function preformattedText(element: HtmlElement): string {
  const chunks: string[] = [];
  const stack: HtmlNode[] = [...element.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "text") {
      chunks.push(node.value);
      continue;
    }
    if (DROP_WITH_CONTENT.has(node.name)) continue;
    if (node.name === "br") chunks.push("\n");
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return chunks
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n/, "")
    .replace(/\n[\t ]*$/, "");
}

export function sanitizeHtml(
  nodes: HtmlNode[],
  baseUrl: string,
  excluded: ReadonlySet<HtmlNode> = new Set()
): SanitizedHtml {
  const html: string[] = [];
  const semantic: string[] = [];
  const stack: SanitizeFrame[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index]!, closing: false, inPre: false });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    if (excluded.has(node)) continue;
    if (node.type === "text") {
      const value = frame.inPre ? node.value.replace(/\r\n?/g, "\n") : node.value.replace(/\s+/gu, " ");
      html.push(escapeText(value));
      semantic.push(value);
      continue;
    }
    if (DROP_WITH_CONTENT.has(node.name)) continue;
    if (node.name === "br") {
      html.push("<br>");
      semantic.push("\n");
      continue;
    }
    if (frame.closing) {
      if (SAFE_ELEMENTS.has(node.name) && !VOID_ELEMENTS.has(node.name)) html.push(`</${node.name}>`);
      if (BLOCK_ELEMENTS.has(node.name)) semantic.push("\n");
      continue;
    }

    if (BLOCK_ELEMENTS.has(node.name)) semantic.push("\n");
    if (SAFE_ELEMENTS.has(node.name)) html.push(`<${node.name}${safeAttributes(node, baseUrl)}>`);
    if (!VOID_ELEMENTS.has(node.name)) {
      stack.push({ node, closing: true, inPre: frame.inPre });
      const inPre = frame.inPre || node.name === "pre";
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.children[index]!, closing: false, inPre });
      }
    }
  }

  return { html: html.join("").trim(), text: normalizeRenderedText(semantic.join("")) };
}

type ParseParent = DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.DocumentFragment | DefaultTreeAdapterTypes.Element;

interface RenderFrame {
  node: HtmlNode;
  closing: boolean;
}

interface SanitizeFrame extends RenderFrame {
  inPre: boolean;
}

function parseChildren(node: ParseParent): DefaultTreeAdapterTypes.ChildNode[] {
  if (isTemplate(node)) return defaultTreeAdapter.getTemplateContent(node).childNodes;
  return node.childNodes;
}

function isTemplate(node: ParseParent): node is DefaultTreeAdapterTypes.Template {
  return node.nodeName === "template";
}

function validateLimits(limits: HtmlParseLimits): void {
  const values = [limits.maxNodes, limits.maxDepth, limits.maxTextChars, limits.maxTextBytes ?? limits.maxTextChars];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError("HTML parse limits must be positive safe integers.");
  }
}

function preflightElementDepthCost(name: string): number {
  return 1 + (name === "table" ? PREFLIGHT_TABLE_WRAPPER_DEPTH : 0);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function normalizeRenderedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function safeAttributes(element: HtmlElement, baseUrl: string): string {
  const safe: Array<[string, string]> = [];
  const className = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter((token) => /^[a-zA-Z0-9_-]+$/.test(token))
    .join(" ");
  if (className) safe.push(["class", className]);
  for (const name of ["alt", "title"] as const) {
    if (element.attributes[name]) safe.push([name, element.attributes[name]!]);
  }
  for (const name of ["colspan", "rowspan"] as const) {
    if (/^[1-9][0-9]{0,2}$/.test(element.attributes[name] ?? "")) safe.push([name, element.attributes[name]!]);
  }
  for (const name of ["href", "src"] as const) {
    const value = element.attributes[name];
    if (!value) continue;
    const resolved = safeContentUrl(value, baseUrl);
    if (resolved) safe.push([name, resolved]);
  }
  return safe.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
}

function safeContentUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || (url.hostname !== "atcoder.jp" && url.hostname !== "img.atcoder.jp")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}
