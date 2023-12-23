import { Request } from "express";
import { z } from "zod";
import { config } from "../../../config";
import { OpenAIPromptMessage } from "../../../tokenization";
import { isCompletionRequest } from "../common";
import { RequestPreprocessor } from ".";

const CLAUDE_OUTPUT_MAX = config.maxOutputTokensAnthropic;
const OPENAI_OUTPUT_MAX = config.maxOutputTokensOpenAI;

// https://console.anthropic.com/docs/api/reference#-v1-complete
export const AnthropicV1CompleteSchema = z.object({
  model: z.string().regex(/^claude-/, "Model must start with 'claude-'"),
  prompt: z.string({
    required_error:
      "No prompt found. Are you sending an OpenAI-formatted request to the Claude endpoint?",
  }),
  max_tokens_to_sample: z.coerce
    .number()
    .int()
    .transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.coerce.number().optional().default(1),
  top_k: z.coerce.number().optional().default(-1),
  top_p: z.coerce.number().optional().default(-1),
  metadata: z.any().optional(),
});



  
// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "model"]),
      content: z.string(),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No prompt found. Are you sending an Anthropic-formatted request to the OpenAI endpoint?",
      invalid_type_error:
        "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
    }
  ),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  n: z
    .literal(1, {
      errorMap: () => ({
        message: "You may only request a single completion at a time.",
      }),
    })
    .optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.coerce
    .number()
    .int()
    .optional()
    .default(16)
    .transform((v) => Math.min(v, OPENAI_OUTPUT_MAX)),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
});

// Text 
const OpenAIV1TextCompletionSchema = z
  .object({
    model: z
      .string()
      .regex(
        /^gpt-3.5-turbo-instruct/,
        "Model must start with 'gpt-3.5-turbo-instruct'"
      ),
    prompt: z.string({
      required_error:
        "No `prompt` found. Ensure you've set the correct completion endpoint.",
    }),
    logprobs: z.number().int().nullish().default(null),
    echo: z.boolean().optional().default(false),
    best_of: z.literal(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    suffix: z.string().optional(),
  })
  .merge(OpenAIV1ChatCompletionSchema.omit({ messages: true }));

// https://developers.generativeai.google/api/python/google/generativeai/generate_text
const PalmChatCompletionSchema = z.object({ // Sorry khanon for borrowing it :v but ffs i don't want to write it out myself ._. 
  model: z.string(), //actually specified in path but we need it for the router
  contents: z.array(
    z.object({
      parts: z.array(z.object({ text: z.string() })),
      role: z.enum(["user", "model"]),
    })
  ),
  tools: z.array(z.object({})).max(0).optional(),
  safetySettings: z.array(z.object({})).max(0).optional(),
  stopSequences: z.array(z.string()).max(5).optional(),
  generationConfig: z.object({
    temperature: z.number().optional(),
    maxOutputTokens: z.coerce
      .number()
      .int()
      .optional()
      .default(16)
      .transform((v) => Math.min(v, 1024)), // TODO: Add config
    candidateCount: z.literal(1).optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    stopSequences: z.array(z.string()).max(5).optional(),
  }),
});

const Ai21ChatCompletionSchema = z.object({
  model: z.string(),
  prompt: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No prompt found. Are you sending an Anthropic-formatted request to the OpenAI endpoint?",
      invalid_type_error:
        "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
    }
  ),
  temperature: z.number().optional().default(1),
  numResults: z.number().optional().default(1),
  stop_sequences: z.union([z.string(), z.array(z.string())]).optional(),
  maxTokens: z.coerce
    .number()
    .int()
    .optional()
    .default(16)
    .transform((v) => Math.max(v, OPENAI_OUTPUT_MAX)),
  topP: z.number().optional(),
  topKReturn: z.number().optional()
});


/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable = !isCompletionRequest(req);
  


  if (alreadyTransformed || notTransformable) {
    return;
  }

  

  if (sameService) {
    const validator =
      req.outboundApi === "openai"
        ? OpenAIV1ChatCompletionSchema
		: req.outboundApi === "anthropic"
		? AnthropicV1CompleteSchema
		: OpenAIV1TextCompletionSchema;
    const result = validator.safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }



  //if (req.inboundApi === "openai" && req.outboundApi === "openai-text") {
  //  req.body = openaiToOpenaiText(req);
  //  return;
  //}
  
  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = await openaiToAnthropic(req.body, req);
    return;
  }
  
  if (req.inboundApi === "openai" && req.outboundApi === "palm") {
    req.body = await openaiToPalm(req.body, req);
    return;
  }
  
  if (req.inboundApi === "openai" && req.outboundApi === "ai21") {
    req.body = await openaiToAi21(req.body, req);
    return;
  }


  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

async function openaiToAi21(body: any, req: Request) {

  const result = Ai21ChatCompletionSchema.safeParse(body);
   
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Ai21 request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt = openAIMessagesToClaudePrompt(messages);

  let stops = rest.stop_sequences
    ? Array.isArray(rest.stop_sequences)
      ? rest.stop_sequences
      : [rest.stop_sequences]
    : [];

  stops.push("\n\nHuman:");
  stops.push("\n\nSystem:");
  stops = [...new Set(stops)];
  


  return {
    ...rest,
	model: "j2-ultra",
    prompt: prompt,
    stopSequences: stops,
  };
}

function openaiToOpenaiText(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-text request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt = flattenOpenAiChatMessages(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push("\n\nUser:");
  stops = [...new Set(stops)];

  const transformed = { ...rest, prompt: prompt, stop: stops };
  const validated = OpenAIV1TextCompletionSchema.parse(transformed);
  return validated;
}

const GoogleAIV1GenerateContentSchema = z.object({
  model: z.string(), //actually specified in path but we need it for the router
  stream: z.boolean().optional().default(false), // also used for router
  contents: z.array(
    z.object({
      parts: z.array(
		  z.object({
			text: z.string(),
			fileData: z.optional(
			  z.object({
				mimeType: z.string(),
				fileUri: z.string(),
			  })
			),
		  })
		),
      role: z.enum(["user", "model"]),
    })
  ),
  tools: z.array(z.object({})).max(0).optional(),
  safetySettings: z.array(z.object({})).max(0).optional(),
  generationConfig: z.object({
    temperature: z.number().optional(),
    maxOutputTokens: z.coerce
      .number()
      .int()
      .optional()
      .default(16)
      .transform((v) => Math.min(v, 1024)), // TODO: Add config
    candidateCount: z.literal(1).optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    stopSequences: z.array(z.string()).max(5).optional(),
  }),
});



export type GoogleAIChatMessage = z.infer<
  typeof GoogleAIV1GenerateContentSchema
>["contents"][0];


async function openaiToPalm(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Palm request"
    );
    throw result.error;
  }
  
  const { messages, ...rest } = result.data;
  const foundNames = new Set<string>();
  const contents = messages
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      // Detects character names so we can set stop sequences for them as Gemini
      // is prone to continuing as the next character.
      // If names are not available, we'll still try to prefix the message
      // with generic names so we can set stops for them but they don't work
      // as well as real names.
      const text = flattenOpenAIMessageContent(m.content);
      const propName = m.name?.trim();
      const textName =
        m.role === "system" ? "" : text.match(/^(.{0,50}?): /)?.[1]?.trim();
      const name =
        propName || textName || (role === "model" ? "Character" : "User");

      foundNames.add(name);

      // Prefixing messages with their character name seems to help avoid
      // Gemini trying to continue as the next character, or at the very least
      // ensures it will hit the stop sequence.  Otherwise it will start a new
      // paragraph and switch perspectives.
      // The response will be very likely to include this prefix so frontends
      // will need to strip it out.
      const textPrefix = textName ? "" : `${name}: `;
      return {
        parts: [{ text: textPrefix + text }],
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      };
    })
    .reduce<GoogleAIChatMessage[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (last?.role === msg.role) {
        last.parts[0].text += "\n\n" + msg.parts[0].text;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push(...Array.from(foundNames).map((name) => `\n${name}:`));
  stops = [...new Set(stops)].slice(0, 5);



//...rest,
  return {
	model: rest.model,
    contents,
	stream: rest.stream,
    tools: [],
    generationConfig: {
      maxOutputTokens: rest.max_tokens,
      stopSequences: stops,
      topP: rest.top_p,
      topK: 40, // openai schema doesn't have this, geminiapi defaults to 40
      temperature: rest.temperature
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
    ],
  };
}

async function openaiToAnthropic(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

  // Anthropic has started versioning their API, indicated by an HTTP header
  // `anthropic-version`. The new June 2023 version is not backwards compatible
  // with our OpenAI-to-Anthropic transformations so we need to explicitly
  // request the older version for now. 2023-01-01 will be removed in September.
  // https://docs.anthropic.com/claude/reference/versioning
  req.headers["anthropic-version"] = "2023-01-01";
  
  const { messages, ...rest } = result.data;
  const prompt = { text : ""}
  prompt.text = openAIMessagesToClaudePrompt(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  // Recommended by Anthropic
  stops.push("\n\nHuman:");
  // Helps with jailbreak prompts that send fake system messages and multi-bot
  // chats that prefix bot messages with "System: Respond as <bot name>".
  stops.push("\n\nSystem:");
  // Remove duplicates
  stops = [...new Set(stops)];

  return {
    ...rest,
    // Model may be overridden in `calculate-context-size.ts` to avoid having
    // a circular dependency (`calculate-context-size.ts` needs an already-
    // transformed request body to count tokens, but this function would like
    // to know the count to select a model).
    model: process.env.CLAUDE_SMALL_MODEL || "claude-v1",
    prompt: prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
  };
}

export function openAIMessagesToClaudePrompt(messages: OpenAIPromptMessage[]) {
  return (
    messages
      .map((m) => {
        let role: string = m.role;
        if (role === "assistant") {
          role = "Assistant";
        } else if (role === "system") {
          role = "System";
        } else if (role === "user") {
          role = "Human";
        }
        // https://console.anthropic.com/docs/prompt-design
        // `name` isn't supported by Anthropic but we can still try to use it.
        return `\n\n${role}: ${m.name?.trim() ? `(as ${m.name}) ` : ""}${
          m.content
        }`;
      })
      .join("") + "\n\nAssistant:"
  );
}



function flattenOpenAiChatMessages(messages: OpenAIPromptMessage[]) {
  // Temporary to allow experimenting with prompt strategies
  const PROMPT_VERSION: number = 1;
  switch (PROMPT_VERSION) {
    case 1:
      return (
        messages
          .map((m) => {
            // Claude-style human/assistant turns
            let role: string = m.role;
            if (role === "assistant") {
              role = "Assistant";
            } else if (role === "system") {
              role = "System";
            } else if (role === "user") {
              role = "User";
            }
            return `\n\n${role}: ${m.content}`;
          })
          .join("") + "\n\nAssistant:"
      );
    case 2:
      return messages
        .map((m) => {
          // Claude without prefixes (except system) and no Assistant priming
          let role: string = "";
          if (role === "system") {
            role = "System: ";
          }
          return `\n\n${role}${m.content}`;
        })
        .join("");
    default:
      throw new Error(`Unknown prompt version: ${PROMPT_VERSION}`);
  }
}


export type OpenAIChatMessage = z.infer<
  typeof OpenAIV1ChatCompletionSchema
>["messages"][0];

function flattenOpenAIMessageContent(
  content: OpenAIChatMessage["content"]
): string {
  return Array.isArray(content)
    ? content
        .map((contentItem) => {
          if ("text" in contentItem) return contentItem.text;
          if ("image_url" in contentItem) return "[ Uploaded Image Omitted ]";
        })
        .join("\n")
    : content;
}
