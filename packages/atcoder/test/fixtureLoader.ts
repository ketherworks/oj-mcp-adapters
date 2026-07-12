import { readFile } from "node:fs/promises";

export function loadHtmlFixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
