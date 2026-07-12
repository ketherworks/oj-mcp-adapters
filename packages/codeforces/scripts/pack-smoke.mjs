import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(packageDir, ".pack-smoke-"));

try {
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "dist", "stale.js"), "stale\n");
  runNpm(["run", "prepack"], { stdio: "inherit" });
  await expectMissing(join(packageDir, "dist", "stale.js"));
  await assertExecutableMode(join(packageDir, "dist", "index.js"), "clean build CLI");

  const packed = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
    encoding: "utf8"
  });
  const report = JSON.parse(packed.stdout)[0];
  const files = new Map(report.files.map((file) => [file.path, file]));
  for (const path of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/worker.js",
    "dist/worker.d.ts",
    "wrangler.jsonc",
    "README.md",
    "LICENSE",
    "package.json"
  ]) {
    if (!files.has(path)) throw new Error(`packed tarball is missing ${path}`);
  }
  if ([...files].some(([path]) => path.startsWith("src/") || path.startsWith("test/") || path.startsWith("scripts/"))) {
    throw new Error("packed tarball contains source, tests, or lifecycle scripts");
  }
  if ([...files].some(([path]) => path.endsWith(".tsbuildinfo"))) {
    throw new Error("packed tarball contains TypeScript build metadata");
  }

  const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (metadata.main !== "dist/index.js" || metadata.types !== "dist/index.d.ts") {
    throw new Error("package main/types do not target dist");
  }
  if (metadata.bin?.["codeforces-mcp-server"] !== "dist/index.js") {
    throw new Error("package bin does not target dist/index.js");
  }
  if (process.platform !== "win32" && (files.get("dist/index.js")?.mode & 0o777) !== 0o755) {
    throw new Error("packed CLI is not mode 0755");
  }

  const archive = join(temporary, report.filename);
  run("tar", ["-xzf", archive, "-C", temporary]);
  const extracted = join(temporary, "package");
  await smokeCli(extracted);
  await smokeWorker(extracted);
  process.stdout.write(`pack smoke passed: ${report.filename} (${report.entryCount} files), CLI and Worker verified\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function smokeCli(extracted) {
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "pack-smoke", version: "0.1.0" }
      }
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "oj_capabilities", arguments: {} } }
  ]
    .map((message) => JSON.stringify(message))
    .join("\n") + "\n";
  const result = run(process.execPath, [join(extracted, "dist", "index.js")], {
    input,
    encoding: "utf8",
    timeout: 10_000
  });
  const messages = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const listed = messages.find((message) => message.id === 2);
  assertToolNames(listed?.result?.tools);
  assertCapabilityTransport(messages.find((message) => message.id === 3)?.result?.structuredContent, "local_stdio");
}

async function smokeWorker(extracted) {
  const module = await import(`${pathToFileURL(join(extracted, "dist", "worker.js")).href}?smoke=${Date.now()}`);
  const response = await module.default.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }),
    {}
  );
  if (response.status !== 200) throw new Error(`packed Worker returned HTTP ${response.status}`);
  const payload = await parseMcpResponse(response);
  assertToolNames(payload?.result?.tools);

  const capabilitiesResponse = await module.default.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "oj_capabilities", arguments: {} }
      })
    }),
    {}
  );
  if (capabilitiesResponse.status !== 200) {
    throw new Error(`packed Worker capabilities returned HTTP ${capabilitiesResponse.status}`);
  }
  const capabilities = await parseMcpResponse(capabilitiesResponse);
  assertCapabilityTransport(capabilities?.result?.structuredContent, "remote_http");
}

function assertToolNames(tools) {
  const actual = Array.isArray(tools) ? tools.map((tool) => tool.name).sort() : [];
  const expected = ["codeforces_get_problem_metadata", "oj_capabilities", "oj_health", "oj_search_problems"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected packed tool list: ${JSON.stringify(actual)}`);
  }
}

function assertCapabilityTransport(capabilities, expected) {
  const operations = capabilities && typeof capabilities === "object" ? Object.values(capabilities.operations ?? {}) : [];
  if (operations.length === 0 || operations.some((operation) => operation?.transport !== expected)) {
    throw new Error(`expected every capability transport to be ${expected}`);
  }
}

async function assertExecutableMode(path, label) {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode & 0o777;
  if (mode !== 0o755) throw new Error(`${label} is mode ${mode.toString(8)}, expected 755`);
}

async function parseMcpResponse(response) {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.length > 6)
    .at(-1);
  if (!data) throw new Error("packed Worker returned an empty event stream");
  return JSON.parse(data.slice(6));
}

async function expectMissing(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`${path} survived the clean build`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: packageDir, ...options });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(String(result.stdout));
    if (result.stderr) process.stderr.write(String(result.stderr));
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  if (process.platform !== "win32") return run("npm", args, options);
  const command = ["npm.cmd", ...args]
    .map((value) => (/\s/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
    .join(" ");
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], options);
}
