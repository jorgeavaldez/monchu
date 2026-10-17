import type { Message } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type HookRegistration,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

/**
 * Base64 bytes of images one conversation may hold. Anthropic rejects requests over 32 MB, and Durable keeps tool
 * results for good, so a conversation past that would fail every later request. This leaves room for text.
 */
export const IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * `read`'s image processor: Photon in a worker thread that exits when idle. Host code, loaded once, so reloads share
 * it; the worker starts only with the first image.
 */
let photon: Promise<ImageProcessor> | undefined;
export const images: ImageProcessor = {
  prepare: async (bytes, mimeType, limits) =>
    (await (photon ??= createNodePhotonImages())).prepare(bytes, mimeType, limits),
};

export function imageBytes(messages: readonly Message[]): number {
  let bytes = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "image") bytes += part.data.length;
  }
  return bytes;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Refuses a tool result's images once the conversation's images would pass the budget, keeping its text: a refusal is
 * cache-safe and leaves the conversation working. The count comes from each request's context, so images that
 * compaction dropped no longer count; images in one round of calls add up as they pass.
 */
export function imageBudget(budget = IMAGE_BUDGET_BYTES): HookRegistration[] {
  // Per conversation: image bytes as of its last request, plus images let through since.
  const held = new Map<ConversationId, number>();
  return [
    hook(GenerationTask, {
      beforeRequest: ({ messages }, api) => {
        held.set(api.conversationId, imageBytes(messages));
        return undefined;
      },
    }),
    hook(ToolTask, {
      afterTool: (_call, result, api): ToolExecutionResult | undefined => {
        const output = result.output;
        if (output === undefined) return undefined;
        const adding = output.reduce(
          (sum, part) => sum + (part.type === "image" ? part.data.length : 0),
          0,
        );
        if (adding === 0) return undefined;
        const holding = held.get(api.conversationId) ?? 0;
        if (holding + adding <= budget) {
          held.set(api.conversationId, holding + adding);
          return undefined;
        }
        return {
          ...result,
          isError: true,
          output: [
            ...output.filter((part) => part.type !== "image"),
            {
              type: "text",
              text: `Image refused: this conversation already holds ${megabytes(holding)} of images and this one adds ${megabytes(adding)}, past its ${megabytes(budget)} budget (requests over 32 MB fail for good). Hand image work to a fresh worker, or combine screenshots into one contact sheet.`,
            },
          ],
        };
      },
    }),
  ];
}
