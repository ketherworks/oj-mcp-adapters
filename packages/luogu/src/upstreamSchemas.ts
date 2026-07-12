import { z } from "zod";

const MAX_TEXT_CHARS = 1_000_000;
const boundedTextSchema = z.string().max(MAX_TEXT_CHARS);
const titleSchema = z.string().trim().min(1).max(500);

export const luoguProblemIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a Luogu problem id without path or URL characters.");

const luoguTagSchema = z.union([z.number().int().nonnegative().max(1_000_000_000), z.string().trim().min(1).max(100)]);
const luoguDifficultySchema = z.number().finite().min(0).max(100).nullable().optional();

const luoguSearchProblemSchema = z
  .object({
    pid: luoguProblemIdSchema,
    title: titleSchema.optional(),
    name: titleSchema.optional(),
    difficulty: luoguDifficultySchema,
    tags: z.array(luoguTagSchema).max(100).optional()
  })
  .passthrough()
  .superRefine((problem, context) => {
    if (!problem.title && !problem.name) {
      context.addIssue({ code: "custom", path: ["title"], message: "Expected title or name." });
    }
  });

export const luoguProblemSearchPayloadSchema = z
  .object({
    data: z
      .object({
        problems: z
          .object({
            count: z.number().int().nonnegative().max(10_000_000),
            result: z.array(luoguSearchProblemSchema).max(100)
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough();

const luoguProblemContentSchema = z
  .object({
    name: titleSchema.optional(),
    background: boundedTextSchema.optional(),
    description: boundedTextSchema.optional(),
    formatI: boundedTextSchema.optional(),
    formatO: boundedTextSchema.optional(),
    hint: boundedTextSchema.optional()
  })
  .passthrough();

const luoguSampleSchema = z.union([
  z.tuple([boundedTextSchema, boundedTextSchema]),
  z
    .object({
      input: boundedTextSchema,
      output: boundedTextSchema
    })
    .passthrough()
]);

const luoguProblemSchema = z
  .object({
    pid: luoguProblemIdSchema,
    title: titleSchema.optional(),
    name: titleSchema.optional(),
    difficulty: luoguDifficultySchema,
    tags: z.array(luoguTagSchema).max(100).optional(),
    description: boundedTextSchema.optional(),
    inputFormat: boundedTextSchema.optional(),
    outputFormat: boundedTextSchema.optional(),
    hint: boundedTextSchema.optional(),
    content: luoguProblemContentSchema.optional(),
    contenu: luoguProblemContentSchema.optional(),
    samples: z.array(luoguSampleSchema).max(100).optional()
  })
  .passthrough()
  .superRefine((problem, context) => {
    if (!problem.title && !problem.name && !problem.content?.name && !problem.contenu?.name) {
      context.addIssue({ code: "custom", path: ["title"], message: "Expected a usable problem title." });
    }
    const hasStatement = Boolean(
      problem.description?.trim() ||
        problem.content?.background?.trim() ||
        problem.content?.description?.trim() ||
        problem.contenu?.background?.trim() ||
        problem.contenu?.description?.trim()
    );
    if (!hasStatement) {
      context.addIssue({ code: "custom", path: ["description"], message: "Expected public problem statement content." });
    }
  });

export const luoguProblemPayloadSchema = z
  .object({
    data: z.object({ problem: luoguProblemSchema }).passthrough()
  })
  .passthrough();

export type LuoguProblemSearchPayload = z.infer<typeof luoguProblemSearchPayloadSchema>;
export type LuoguProblemPayload = z.infer<typeof luoguProblemPayloadSchema>;
