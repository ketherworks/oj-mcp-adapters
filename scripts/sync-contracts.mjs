import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sourceRootArgument = process.argv[2];
if (!sourceRootArgument) {
  throw new Error("Usage: npm run sync:contracts -- <student-autocomplete-lab-root>");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(sourceRootArgument);
const sourceDirectory = path.join(sourceRoot, "src", "domain", "oj");
const targetDirectory = path.join(repositoryRoot, "packages", "contracts", "src");
const schemaTarget = path.join(repositoryRoot, "packages", "contracts", "schema", "v1");

await mkdir(targetDirectory, { recursive: true });
await mkdir(schemaTarget, { recursive: true });

for (const fileName of ["contracts.ts", "providerManifest.ts", "schemaPrimitives.ts", "schemas.ts"]) {
  await cp(path.join(sourceDirectory, fileName), path.join(targetDirectory, fileName));
}
await cp(path.join(sourceRoot, "resources", "oj-contract", "v1"), schemaTarget, { recursive: true, force: true });
