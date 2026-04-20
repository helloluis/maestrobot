import type { Tool } from "@maestrobot/providers"
import type { PairwisePreference } from "./types.js"

export const CAST_PREFERENCE_TOOL: Tool = {
  type: "function",
  function: {
    name: "cast_preference",
    description:
      "Cast your pairwise preference between two stems, with reasoning in your own voice.",
    parameters: {
      type: "object",
      required: ["preferred", "reasoning"],
      properties: {
        preferred: {
          enum: ["a", "b", "tie"],
          description: "Which stem you prefer. 'tie' is allowed but costs credibility if overused.",
        },
        reasoning: {
          type: "string",
          maxLength: 280,
          description: "One or two sentences in your voice explaining the preference.",
        },
      },
    },
  },
}

export function parsePreference(args: Record<string, unknown>): PairwisePreference {
  const raw = typeof args.preferred === "string" ? args.preferred.toLowerCase() : ""
  const preferred: PairwisePreference["preferred"] =
    raw === "a" || raw === "b" || raw === "tie" ? raw : "tie"
  const reasoning = typeof args.reasoning === "string" ? args.reasoning.slice(0, 280) : ""
  return { preferred, reasoning }
}
