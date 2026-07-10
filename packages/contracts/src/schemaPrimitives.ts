import { z } from "zod";

export const ojPlatformIdSchema = z.enum(["luogu", "leetcode", "nowcoder", "codeforces", "atcoder"]);
export const ojCapabilityNameSchema = z.enum([
  "searchProblems",
  "fetchProblem",
  "importProblem",
  "fetchProfile",
  "listSubmissions",
  "localRun",
  "platformRun",
  "prepareSubmission",
  "commitSubmission",
  "pollSubmission"
]);
export const ojProviderToolNameSchema = z.union([z.enum(["capabilities", "health"]), ojCapabilityNameSchema]);
export const ojOperationRiskSchema = z.enum([
  "R0_public_read",
  "R1_private_read",
  "R2_local_execute",
  "R3_prepare_write",
  "R4_real_submit"
]);
