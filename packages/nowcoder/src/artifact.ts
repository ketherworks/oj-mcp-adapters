import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { OjCodeArtifact } from "@kaiserunix/oj-mcp-contracts";
import { NowCoderAdapterError } from "./errors.js";

const MAX_CODE_BYTES = 1024 * 1024;
const UNSAFE_DISPLAY_CHARACTER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export interface VerifiedCodeArtifact {
  filePath: string;
  fileName: string;
}

export type NowCoderArtifactVerifier = (
  artifact: OjCodeArtifact,
  signal?: AbortSignal
) => Promise<VerifiedCodeArtifact>;

export const verifySavedCodeArtifact: NowCoderArtifactVerifier = async (artifact, signal) => {
  if (artifact.sourceWasDirty) {
    throw new NowCoderAdapterError("policy.blocked", "Save the source file before a NowCoder run or submission.");
  }
  if (!artifact.sourceUri) {
    throw new NowCoderAdapterError("request.invalid", "NowCoder judge actions require the saved source file's file: URI.");
  }

  let requestedPath: string;
  try {
    const url = new URL(artifact.sourceUri);
    if (url.protocol !== "file:" || url.hostname !== "") throw new Error("not a local file URI");
    requestedPath = fileURLToPath(url);
  } catch {
    throw new NowCoderAdapterError("request.invalid", "sourceUri must be an absolute file: URI for the saved source file.");
  }
  if (requestedPath.startsWith("\\\\")) {
    throw new NowCoderAdapterError("policy.blocked", "Network and device file paths are not accepted for NowCoder judge actions.");
  }

  let filePath: string;
  let metadata;
  try {
    filePath = await realpath(requestedPath);
    metadata = await stat(filePath);
  } catch {
    throw new NowCoderAdapterError("resource.not_found", "The saved source file could not be resolved.");
  }
  if (filePath.startsWith("\\\\")) {
    throw new NowCoderAdapterError("policy.blocked", "The resolved source file must stay on a local filesystem.");
  }
  if (!metadata.isFile()) {
    throw new NowCoderAdapterError("request.invalid", "sourceUri must resolve to a regular file.");
  }
  if (metadata.size > MAX_CODE_BYTES) {
    throw new NowCoderAdapterError("request.invalid", "NowCoder source files must not exceed 1 MiB.");
  }
  if (UNSAFE_DISPLAY_CHARACTER.test(filePath)) {
    throw new NowCoderAdapterError("policy.blocked", "The source path contains control or bidirectional formatting characters.");
  }

  const fileName = basename(filePath);
  if (artifact.fileName !== undefined && artifact.fileName !== fileName) {
    throw new NowCoderAdapterError("confirmation.mismatch", "The code artifact file name does not match its resolved source path.");
  }

  let source: string;
  try {
    source = await readFile(filePath, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new NowCoderAdapterError("upstream.unavailable", "The saved source file could not be read.");
  }
  const bytes = Buffer.byteLength(source, "utf8");
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (source !== artifact.source || bytes !== artifact.bytes || sha256 !== artifact.sha256.toLowerCase()) {
    throw new NowCoderAdapterError("confirmation.mismatch", "The saved source file no longer matches the immutable code artifact.");
  }
  return { filePath, fileName };
};

export function safeConfirmationValue(value: string, label: string): string {
  if (value.length === 0 || value.length > 1_024 || UNSAFE_DISPLAY_CHARACTER.test(value)) {
    throw new NowCoderAdapterError("policy.blocked", `${label} cannot be displayed safely in a confirmation prompt.`);
  }
  return value;
}
