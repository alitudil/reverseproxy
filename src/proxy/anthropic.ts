import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import { keyPool } from "../key-management";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { RequestPreprocessor } from "./middleware/request";
import { AnthropicV1CompleteSchema } from "./middleware/request/transform-outbound-payload";


import {
  addKey,
  addAnthropicPreamble,
  blockZoomerOrigins,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  removeOriginHeaders,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [] };

  const claudeVariants = [
    "claude-v1",
    "claude-v1-100k",
    "claude-instant-v1",
    "claude-instant-v1-100k",
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-v1.2",
    "claude-v1.0",
    "claude-instant-v1.1",
    "claude-instant-v1.1-100k",
    "claude-instant-v1.0",
    "claude-2", // claude-2 is 100k by default it seems
    "claude-2.0",
    "claude-2.1",
	"anthropic.claude-v1",
	"anthropic.claude-v2:0",
	"anthropic.claude-v2:1",
	"anthropic.claude-instant-v1"
  ];

  const models = claudeVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteAnthropicRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    addAnthropicPreamble,
    languageFilter,
    blockZoomerOrigins,
    removeOriginHeaders,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

/** Only used for non-streaming requests. */
const anthropicResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }


  if (req.inboundApi === "openai") {
    req.log.info("Transforming Anthropic response to OpenAI format");
    body = transformAnthropicResponse(body);
  }

  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicResponse(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}


async function sign(request: HttpRequest, accessKeyId: string, secretAccessKey: string, region: string) {
  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });
  return signer.sign(request);
}

export const awsCheck: RequestPreprocessor = async (req) => {
	req.key = keyPool.get(req.body.model, false);

	if (req.key?.isAws) {
		const strippedParams = AnthropicV1CompleteSchema.pick({
			prompt: true,
			max_tokens_to_sample: true,
			stop_sequences: true,
			temperature: true,
			top_k: true,
			top_p: true,
		  }).parse(req.body);

		
		
		let { model, stream } = req.body;
		req.isStreaming = stream === true || stream === "true";
		
		let modelSelected = model
		if (modelSelected == "claude-2.1" || modelSelected == "claude-2"){
			modelSelected = "anthropic.claude-v2:1"
		} else if (modelSelected == "claude-2.0"){
			modelSelected = "anthropic.claude-v2:0"
		} else if (modelSelected == "claude-v1" || modelSelected == "claude-v1-100k" || modelSelected == "claude-v1.0"){
			modelSelected = "anthropic.claude-v1"
		} else if (modelSelected.includes("instant")) {
			modelSelected = "anthropic.claude-instant-v1"
		} else {
			// Would need to preffet non aws keys ':v but well for now.. this is it :3 
			modelSelected = "anthropic.claude-v2:1"
		}
		
		let preamble = req.body.prompt.startsWith("\n\nHuman:") ? "" : "\n\nHuman:";
		req.body.prompt = preamble + req.body.prompt;

		req.body.model = modelSelected
		
		const key = req.key.key 
		const awsSecret = req.key.awsSecret || ""
		const awsRegion = req.key.awsRegion || ""
		
		req.headers["anthropic-version"] = "2023-06-01";
		
		const host = req.key.endpoint || ""
		const newRequest = new HttpRequest({
		method: "POST",
		protocol: "https:",
		hostname: `bedrock-runtime.${awsRegion}.amazonaws.com`,
		path: `/model/${modelSelected}/invoke${stream ? "-with-response-stream" : ""}`,
		headers: {
		  ["Host"]: `bedrock-runtime.${awsRegion}.amazonaws.com`,
		  ["content-type"]: "application/json",  
			},
			body: JSON.stringify(strippedParams),
		});
		
		if (stream) {
			newRequest.headers["x-amzn-bedrock-accept"] = "application/json";
		} else {
			newRequest.headers["accept"] = "*/*";
		}
		req.signedRequest = await sign(newRequest, key, awsSecret, awsRegion);

	} else {
		const newRequest = new HttpRequest({
		  method: "POST",
		  protocol: "https:",
		  hostname: "https://api.anthropic.com",
		  path: `/v1/complete`,
		}) 
		req.newRequest = newRequest
  }

}
	
	



const anthropicProxy = createQueueMiddleware({
  beforeProxy: awsCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must create new request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    on: {
      proxyReq: rewriteAnthropicRequest,
      proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
    pathRewrite: {
      // Send OpenAI-compat requests to the real Anthropic endpoint.
      "^/v1/chat/completions": "",
    },
  }),
});

const anthropicRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
anthropicRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
anthropicRouter.get("/v1/models", handleModelRequest);
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "anthropic", outApi: "anthropic" }),
  anthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "anthropic" }),
  anthropicProxy
);
// Redirect browser requests to the homepage.
anthropicRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const anthropic = anthropicRouter;
