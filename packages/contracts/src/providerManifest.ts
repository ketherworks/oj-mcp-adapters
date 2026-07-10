import { z } from "zod";
import { ojOperationRiskSchema, ojPlatformIdSchema, ojProviderToolNameSchema } from "./schemaPrimitives.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.");
const secretLikeArgument = /(cookie|token|password|api[-_]?key)/i;

export const ojProviderArtifactDescriptorSchema = z
  .object({
    sourceUrl: z.url(),
    repository: z.url(),
    version: z.string().min(1),
    commit: z.string().regex(/^[a-f0-9]{40}$/i),
    os: z.array(z.string().min(1)).min(1),
    arch: z.array(z.string().min(1)).min(1),
    runtime: z.string().min(1),
    archiveSha256: sha256Schema,
    filesSha256: sha256Schema,
    signatureOrAttestation: z.string().min(1).optional(),
    sbomSha256: sha256Schema,
    license: z.string().min(1)
  })
  .strict();

export const ojProviderEntrypointSchema = z
  .object({
    id: z.enum(["agentReadOnly", "productPrivate", "remotePublic"]),
    transport: z.enum(["local_stdio", "remote_http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.url().optional(),
    expectedTools: z.array(
      z
        .object({
          canonical: ojProviderToolNameSchema,
          upstream: z.string().min(1),
          schemaSha256: sha256Schema,
          risk: ojOperationRiskSchema
        })
        .strict()
    ),
    allowedRisks: z.array(ojOperationRiskSchema),
    secretRefs: z
      .array(
        z
          .object({
            logicalName: z.string().min(1),
            secretStorageKey: z.string().min(1),
            envName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            required: z.boolean()
          })
          .strict()
      )
      .optional()
  })
  .strict()
  .superRefine((entrypoint, context) => {
    if (entrypoint.transport === "local_stdio" && !entrypoint.command) {
      context.addIssue({ code: "custom", path: ["command"], message: "Local stdio entrypoints require a command." });
    }
    if (entrypoint.transport === "remote_http" && !entrypoint.url) {
      context.addIssue({ code: "custom", path: ["url"], message: "Remote HTTP entrypoints require a URL." });
    }
    for (const [index, argument] of (entrypoint.args ?? []).entries()) {
      if (secretLikeArgument.test(argument)) {
        context.addIssue({ code: "custom", path: ["args", index], message: "Manifest arguments must not contain credentials." });
      }
    }

    const agentAllowed = new Set(["R0_public_read", "R1_private_read"]);
    if (entrypoint.id === "agentReadOnly") {
      for (const [index, risk] of entrypoint.allowedRisks.entries()) {
        if (!agentAllowed.has(risk)) {
          context.addIssue({ code: "custom", path: ["allowedRisks", index], message: "Agent entrypoints may expose only R0/R1." });
        }
      }
      for (const [index, tool] of entrypoint.expectedTools.entries()) {
        if (!agentAllowed.has(tool.risk)) {
          context.addIssue({ code: "custom", path: ["expectedTools", index, "risk"], message: "Agent tools may expose only R0/R1." });
        }
      }
    }
  });

export const ojProviderManifestSchema = z
  .object({
    schemaVersion: z.literal("oj-provider-manifest/v1"),
    providerId: z.string().min(1),
    platform: ojPlatformIdSchema,
    minimumExtensionVersion: z.string().min(1),
    installDirectoryLayout: z.string().min(1),
    artifacts: z
      .object({
        active: ojProviderArtifactDescriptorSchema,
        rollback: ojProviderArtifactDescriptorSchema
      })
      .strict(),
    entrypoints: z.array(ojProviderEntrypointSchema).min(1),
    expectedProtocol: z.literal("2025-11-25")
  })
  .strict();
