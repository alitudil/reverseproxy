import { RequestHandler, Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool } from "../key-management";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import { RequestPreprocessor } from "./middleware/request";
import { HttpRequest } from "@smithy/protocol-http";

import {
  addKey,
  addImageFromPrompt,
  blockZoomerOrigins,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  limitCompletions,
  removeOriginHeaders,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;



function getModelsResponse() {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  // https://platform.openai.com/docs/models/overview
  const gptVariants = [
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-0314",
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-32k-0314",
    "gpt-4-1106-preview",
    "gpt-4-vision-preview",
    "gpt-3.5-turbo-1106", 
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
	"gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914"
  ];

  const gpt4Available = keyPool.list().filter((key) => {
    return key.service === "openai" && !key.isDisabled && key.isGpt4;
  }).length;

  const models = gptVariants
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "openai",
      permission: [
        {
          id: "modelperm-" + id,
          object: "model_permission",
          created: new Date().getTime(),
          organization: "*",
          group: null,
          is_blocking: false,
        },
      ],
      root: id,
      parent: null,
    }))
    .filter((model) => {
      if (model.id.startsWith("gpt-4")) {
        return gpt4Available > 0;
      }
      return true;
    });

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
}

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};


function transformTurboInstructResponse(
  turboInstructBody: Record<string, any>
): Record<string, any> {
  const transformed = { ...turboInstructBody };
  transformed.choices = [
    {
      ...turboInstructBody.choices[0],
      message: {
        role: "assistant",
        content: turboInstructBody.choices[0].text.trim(),
      },
    },
  ];
  delete transformed.choices[0].text;
  return transformed;
}


const rewriteForTurboInstruct: RequestPreprocessor = (req) => {
  // /v1/turbo-instruct/v1/chat/completions accepts either prompt or messages.
  // Depending on whichever is provided, we need to set the inbound format so
  // it is transformed correctly later.
  if (req.body.prompt && !req.body.messages) {
    //req.inboundApi = "openai-text";
  } else if (req.body.messages && !req.body.prompt) {
    req.inboundApi = "openai";
    // Set model for user since they're using a client which is not aware of
    // turbo-instruct.
    req.body.model = "gpt-3.5-turbo-instruct";
  } else {
    throw new Error("`prompt` OR `messages` must be provided");
  }

  req.url = "/v1/completions";
};


const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
	addImageFromPrompt,
    languageFilter,
    limitCompletions,
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

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  //if (req.outboundApi === "openai-text" && req.inboundApi === "openai") {
  //  req.log.info("Transforming Turbo-Instruct response to Chat format");
  //  body = transformTurboInstructResponse(body);
  //}


  res.status(200).json(body);
};


const SPECIAL_HOST =
  process.env.SPECIAL_HOST || "%endpoint%";




export const specialCheck: RequestPreprocessor = async (req) => {
	req.key = keyPool.get(req.body.model, false);
	
	const strippedParams = req.body
	
	if (req.key?.key.includes(";")) {
		if (req.key?.specialMap) {
			const deployment = req.key?.specialMap[req.body.model] ;
			const host = req.key.endpoint || ""
			const newRequest = new HttpRequest({
			method: "POST",
			protocol: "https:",
			hostname: host.replace("https://",""),
			path: `/openai/deployments/${deployment}/chat/completions?api-version=2023-03-15-preview`,
			headers: {
			  ["Host"]: host,
			  ["Content-Type"]: "application/json",
			  ["api-key"]: `${req.key.auth}` || "",
			},
			body: JSON.stringify(strippedParams),
		  });
		  req.newRequest = newRequest
	  }
	  
	} else {
		const newRequest = new HttpRequest({
		  method: "POST",
		  protocol: "https:",
		  hostname: "api.openai.com",
		  path: `/v1/chat/completions`,
		});
		req.newRequest = newRequest
	  }
	
}


// https://api.openai.com
// 		proxyReq.setHeader('host', assignedKey.endpoint + '/openai/deployments/gpt-4/chat/completions?api-version=2023-03-15-preview');
const openaiProxy = createQueueMiddleware({
  beforeProxy: specialCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ newRequest }) => {
      if (!newRequest) throw new Error("Must create new request before proxying");
      return `${newRequest.protocol}//${newRequest.hostname}`;
    },
    changeOrigin: true,
	selfHandleResponse: true,
	logger,
    on: {
      proxyReq: rewriteRequest,
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
  })
  
});

const openaiRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
openaiRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
openaiRouter.get("/v1/models", handleModelRequest);


openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);


//openaiRouter.post(
//  /\/v1\/turbo\-instruct\/(v1\/)?chat\/completions/,
//  ipLimiter,
//  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai-text" }, [
//    rewriteForTurboInstruct,
//  ]),
//  openaiProxy
//);


// Redirect browser requests to the homepage.
openaiRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
openaiRouter.use((req, res) => {
  req.log.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
