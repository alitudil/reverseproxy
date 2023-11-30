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
  //addAi21Preamble,
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

  if (!config.ai21Key) return { object: "list", data: [] };

  const ai21Variants = [
    "gpt-j2-ultra"
  ]; 

  const models = ai21Variants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "ai21",
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

const rewriteAi21Request = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    //addAi21Preamble,
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
const ai21ResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
	
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Ai21 response to OpenAI format");
    body = transformAi21Response(body);
  }
 

  res.status(200).json(body);
};



/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAi21Response(
  ai21Body: Record<string, any>
): Record<string, any> {
  return {
    id: "ai21-" + ai21Body.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: ai21Body.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "text",
          content: ai21Body.completions[0].data.text?.trim(),
        },
        finish_reason: ai21Body.stop_reason,
        index: 0,
      },
    ],
  };
}

const ai21Proxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.ai21.com/studio/v1/j2-ultra/complete",
    changeOrigin: true,
    on: {
      proxyReq: rewriteAi21Request,
      proxyRes: createOnProxyResHandler([ai21ResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/ai21/chat/completions': '', 
	  }
  })
});

const ai21Router = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
ai21Router.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
ai21Router.get("/v1/models", handleModelRequest);
ai21Router.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "ai21", outApi: "ai21" }),
  ai21Proxy
);
// OpenAI-to-Ai21 compatibility endpoint.
ai21Router.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "ai21" }),
  (req, res, next) => {
    req.url = req.originalUrl; // Reset the URL to include the full path
    ai21Proxy(req, res, next);
  }
);
// Redirect browser requests to the homepage.
ai21Router.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const ai21 = ai21Router;
