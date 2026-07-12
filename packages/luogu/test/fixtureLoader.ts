import { readFile } from "node:fs/promises";

export async function loadJsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await loadTextFixture(name));
}

export function loadTextFixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
