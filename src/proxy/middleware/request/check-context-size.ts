import { Request } from "express";
import { z } from "zod";
import { config } from "../../../config";
import { countTokens } from "../../../tokenization";
import { RequestPreprocessor } from ".";

const CLAUDE_MAX_CONTEXT = config.maxContextTokensAnthropic;
const OPENAI_MAX_CONTEXT = config.maxContextTokensOpenAI;

/**
 * Assigns `req.promptTokens` and `req.outputTokens` based on the request body
 * and outbound API format, which combined determine the size of the context.
 * If the context is too large, an error is thrown.
 * This preprocessor should run after any preprocessor that transforms the
 * request body.
 */
export const checkContextSize: RequestPreprocessor = async (req) => {
  let prompt;

  switch (req.outboundApi) {
    case "openai":
      req.outputTokens = req.body.max_tokens;
      prompt = req.body.messages;
      break;
	//case "openai-text": {
    //  req.outputTokens = req.body.max_tokens;
    //  prompt = req.body.prompt;
    //  break;
    //}
    case "anthropic":
      req.outputTokens = req.body.max_tokens_to_sample;
      prompt = req.body.prompt;
      break;
	case "aws":
      req.outputTokens = req.body.max_tokens_to_sample;
      prompt = req.body.prompt;
      break;  
	case "palm":
	  req.outputTokens = 1; // ._. 
      prompt = req.body.prompt;
      break;  
	case "ai21":
	  req.outputTokens = 1; // ._. ?
      prompt = req.body.prompt;
      break;  
    default:
      throw new Error(`Unknown outbound API: ${req.outboundApi}`);
  }

  const result = await countTokens({ req, prompt, service: req.outboundApi });
  req.promptTokens = result.token_count;

  // TODO: Remove once token counting is stable
  req.log.debug({ result: result }, "Counted prompt tokens.");
  req.debug = req.debug ?? {};
  req.debug = { ...req.debug, ...result };

  maybeReassignModel(req);
  validateContextSize(req);
};

function validateContextSize(req: Request) {
  assertRequestHasTokenCounts(req);
  const promptTokens = req.promptTokens;
  const outputTokens = req.outputTokens;
  const contextTokens = promptTokens + outputTokens;
  const model = req.body.model;

  const proxyMax =
    (req.outboundApi === "openai" ? OPENAI_MAX_CONTEXT : CLAUDE_MAX_CONTEXT) ||
    Number.MAX_SAFE_INTEGER;
  let modelMax = 0;

  if (model.match(/gpt-3.5-turbo-16k/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-3.5-turbo-1106/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-3.5-turbo/)) {
    modelMax = 4096;
  } else if (model.match(/gpt-4-vision-preview/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-1106-preview/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-32k/)) {
    modelMax = 32768;
  } else if (model.match(/gpt-4/)) {
    modelMax = 8192;
  } else if (model.match(/claude-(?:instant-)?v1(?:\.\d)?(?:-100k)/)) {
    modelMax = 100000;
  } else if (model.match(/claude-(?:instant-)?v1(?:\.\d)?$/)) {
    modelMax = 9000;
  } else if (model.match(/claude-2/)) {
    modelMax = 100000;
  } else if (model.match(/text-bison-001-32k/)) {
    modelMax = 32768; // doesn't matter 
  } else if (model.match(/gemini-pro/)) {
    modelMax = 32768; // doesn't matter 
  } else if (model.match(/text-bison-001/)) {
    modelMax = 8192; // doesn't matter 
  } else if (model.match(/j2-ultra/)) {
    modelMax = 8192; // doesn't matter 
  } else {
    // Don't really want to throw here because I don't want to have to update
    // this ASAP every time a new model is released.
    req.log.warn({ model }, "Unknown model, using 100k token limit.");
    modelMax = 100000;
  }

  const finalMax = Math.min(proxyMax, modelMax);
  z.number()
    .int()
    .max(finalMax, {
      message: `Your request exceeds the context size limit for this model or proxy. (max: ${finalMax} tokens, requested: ${promptTokens} prompt + ${outputTokens} output = ${contextTokens} context tokens)`,
    })
    .parse(contextTokens);

  req.log.debug(
    { promptTokens, outputTokens, contextTokens, modelMax, proxyMax },
    "Prompt size validated"
  );

  req.debug.prompt_tokens = promptTokens;
  req.debug.max_model_tokens = modelMax;
  req.debug.max_proxy_tokens = proxyMax;
}

function assertRequestHasTokenCounts(
  req: Request
): asserts req is Request & { promptTokens: number; outputTokens: number } {
  z.object({
    promptTokens: z.number().int().min(1),
    outputTokens: z.number().int().min(1),
  })
    .nonstrict()
    .parse(req);
}

/**
 * For OpenAI-to-Anthropic requests, users can't specify the model, so we need
 * to pick one based on the final context size. Ideally this would happen in
 * the `transformOutboundPayload` preprocessor, but we don't have the context
 * size at that point (and need a transformed body to calculate it).
 */
function maybeReassignModel(req: Request) {
  if (req.inboundApi !== "openai" || req.outboundApi !== "anthropic") {
    return;
  }

  const bigModel = process.env.CLAUDE_BIG_MODEL || "claude-v1-100k";
  const contextSize = req.promptTokens! + req.outputTokens!;

  if (contextSize > 8500) {
    req.log.debug(
      { model: bigModel, contextSize },
      "Using Claude 100k model for OpenAI-to-Anthropic request"
    );
    req.body.model = bigModel;
  }
  // Small model is the default already set in `transformOutboundPayload`
}
