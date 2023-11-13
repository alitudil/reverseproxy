import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
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

  if (!config.awsKey) return { object: "list", data: [] };

  const awsVariants = [ // For now just 1.3 and 2.0, priority is 2.0 
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-2", // claude-2 is 100k by default it seems
    "claude-2.0",
  ];

  const models = awsVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "aws",
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


/** Only used for non-streaming requests. */
const awsResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  console.log(res);


  if (req.inboundApi === "openai") {
    req.log.info("Transforming AWS response to OpenAI format");
    body = transformAwsResponse(body);
  }

  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
 
/** Sign request 
async function sign(request: HttpRequest, credential: Credential) {
  const { accessKeyId, secretAccessKey, region } = credential;

  const signer = new SignatureV4({
    sha256: "",
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });

  return signer.sign(request);
}
*/
 
function transformAwsResponse(
  awsBody: Record<string, any>
): Record<string, any> {
  return {
    id: "aws-" + awsBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: awsBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}




// Change how models are changed require 
const rewriteAwsRequest = (
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




const awsProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-v2/invoke",
    changeOrigin: false,
    on: {
      proxyReq: rewriteAwsRequest,
      proxyRes: createOnProxyResHandler([awsResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
  })
);





const awsRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
awsRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});


awsRouter.get("/v1/models", handleModelRequest);
awsRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "aws", outApi: "aws" }),
  awsProxy
);
// OpenAI-to-Anthropic compatibility endpoint.
awsRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "aws" }),
  awsProxy
);
// Redirect browser requests to the homepage.
awsRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const aws = awsRouter;
