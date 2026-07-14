import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { OjCodeArtifact } from "@kaiserunix/oj-mcp-contracts";
import { verifySavedCodeArtifact } from "../src/artifact.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("saved NowCoder code artifacts", () => {
  test("binds the immutable artifact to the resolved saved file", async () => {
    const { artifact, filePath } = await savedArtifact("int main(){return 0;}\n");

    await expect(verifySavedCodeArtifact(artifact)).resolves.toEqual({ filePath, fileName: "main.cpp" });
  });

  test("rejects unsaved, mislabeled, and changed source files", async () => {
    const { artifact, filePath } = await savedArtifact("print('ok')\n", "main.py");

    await expect(verifySavedCodeArtifact({ ...artifact, sourceWasDirty: true })).rejects.toMatchObject({ code: "policy.blocked" });
    await expect(verifySavedCodeArtifact({ ...artifact, sourceUri: undefined })).rejects.toMatchObject({ code: "request.invalid" });
    await expect(verifySavedCodeArtifact({ ...artifact, sourceUri: "file://remote-host/share/main.py" })).rejects.toMatchObject({ code: "request.invalid" });
    await expect(verifySavedCodeArtifact({ ...artifact, fileName: "not-main.py" })).rejects.toMatchObject({ code: "confirmation.mismatch" });
    await writeFile(filePath, "print('changed')\n", "utf8");
    await expect(verifySavedCodeArtifact(artifact)).rejects.toMatchObject({ code: "confirmation.mismatch" });
  });
});

async function savedArtifact(source: string, fileName = "main.cpp"): Promise<{ artifact: OjCodeArtifact; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "nowcoder-artifact-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, fileName);
  await writeFile(filePath, source, "utf8");
  return {
    filePath,
    artifact: {
      languageKey: fileName.endsWith(".py") ? "python" : "cpp",
      source,
      sha256: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
      fileName,
      sourceUri: pathToFileURL(filePath).href,
      capturedAt: "2026-07-14T17:00:00.000Z",
      sourceWasDirty: false
    }
  };
}
