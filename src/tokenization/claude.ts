import { Tiktoken } from "tiktoken/lite";
import claude from "./claude.json";

let encoder: Tiktoken;

export function init() {
  encoder = new Tiktoken(
    claude.bpe_ranks,
    claude.special_tokens,
    claude.pat_str
  );
  return true;
}

// Tested against:
// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb

export function getTokenCount(prompt: string) {
  let numTokens = 0;
  if (prompt.length > 1000000) {
	  numTokens = 200000;
	  return {
		tokenizer: "tiktoken (prompt length limit exceeded)",
		token_count: numTokens,
	  };
	}
     numTokens += encoder.encode(prompt.normalize('NFKC'), 'all').length;
  return { tokenizer: "tiktoken", token_count: numTokens };
}

