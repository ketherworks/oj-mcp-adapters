import { pathToFileURL } from "node:url";

export function assertPublishPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new Error("npm publish is not supported on Windows; publish release packages from Linux CI");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertPublishPlatform();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
