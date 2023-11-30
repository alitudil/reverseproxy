import { Request } from "express";
import { config } from "../config";
import {
  init as initClaude,
  getTokenCount as getClaudeTokenCount,
} from "./claude";
import {
  init as initOpenAi,
  getTokenCount as getOpenAITokenCount,
  OpenAIPromptMessage,
} from "./openai";

import {
  init as initPalmAi,
  getTokenCount as getPalmTokenCount,
} from "./palm";

import {
  init as initAi21Ai,
  getTokenCount as getAi21TokenCount,
} from "./ai21";

export async function init() {
  if (config.anthropicKey) {
    initClaude();
  }
  if (config.openaiKey) {
    initOpenAi();
  }
}

type TokenCountResult = {
  token_count: number;
  tokenizer: string;
  tokenization_duration_ms: number;
};
type TokenCountRequest = {
  req: Request;
} & (
  | { prompt: string; service: "anthropic" }
  | { prompt: string; service: "aws" }
  | { prompt: string; service: "palm" }
  | { prompt: string; service: "ai21" }
  | { prompt: OpenAIPromptMessage[]; service: "openai" }
  
);
export async function countTokens({
  req,
  service,
  prompt,
}: TokenCountRequest): Promise<TokenCountResult> {
  const time = process.hrtime();
  switch (service) {
    case "anthropic":
      return {
        ...getClaudeTokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "aws":
      return {
        ...getClaudeTokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	//case "openai-text":
    //  return {
    //    ...getOpenAITokenCount(prompt, req.body.model),
    //    tokenization_duration_ms: getElapsedMs(time),
    //  };
	case "palm":
		return {
        ...getPalmTokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "ai21":
		return {
        ...getAi21TokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };  
    default:
      throw new Error(`Unknown service: ${service}`);
  }
}

function getElapsedMs(time: [number, number]) {
  const diff = process.hrtime(time);
  return diff[0] * 1000 + diff[1] / 1e6;
}
