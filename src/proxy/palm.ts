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
  //addPalmPreamble,
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

  if (!config.palmKey) return { object: "list", data: [] };

  const palmVariants = [
    "gpt-text-bison-001"
  ]; // F u ;v 

  const models = palmVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "openai",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};


const removeStreamProperty = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse,
  options: any
) => {
  if (req.body && typeof req.body === "object") {
    delete req.body.stream;
  }
};

const rewritePalmRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    //addPalmPreamble,
    languageFilter,
    blockZoomerOrigins,
    removeOriginHeaders,
    removeStreamProperty,
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
const palmResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
	
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Palm response to OpenAI format");
    body = transformPalmResponse(body);
  }
 

  res.status(200).json(body);
};



/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformPalmResponse(
  palmBody: Record<string, any>
): Record<string, any> {
  const output = (palmBody.candidates[0]?.output || palmBody.candidates.output)?.trim();
  return {
    id: "palm-" + palmBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: palmBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "text",
          content: output,
        },
        finish_reason: palmBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const palmProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText",
    changeOrigin: true,
    on: {
      proxyReq: rewritePalmRequest,
      proxyRes: createOnProxyResHandler([palmResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/palm/chat/completions': '', 
	  }
  })
});

const palmRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
palmRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
palmRouter.get("/v1/models", handleModelRequest);
palmRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "palm", outApi: "palm" }),
  palmProxy
);
// OpenAI-to-Palm compatibility endpoint.
palmRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "palm" }),
  (req, res, next) => {
    req.url = req.originalUrl; // Reset the URL to include the full path
    palmProxy(req, res, next);
  }
);
// Redirect browser requests to the homepage.
palmRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const palm = palmRouter;
