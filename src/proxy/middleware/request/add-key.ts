import { Key, keyPool } from "../../../key-management";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

/** Add a key that can service this request to the request object. */
export const addKey: ProxyRequestMiddleware = (proxyReq, req) => {
  let assignedKey: Key;
  

  if (!isCompletionRequest(req)) {
    // Horrible, horrible hack to stop the proxy from complaining about clients
    // not sending a model when they are requesting the list of models (which
    // requires a key, but obviously not a model).
    // TODO: shouldn't even proxy /models to the upstream API, just fake it
    // using the models our key pool has available.
    req.body.model = "gpt-3.5-turbo";
  }

  if (!req.inboundApi || !req.outboundApi) {
    const err = new Error(
      "Request API format missing. Did you forget to add the request preprocessor to your router?"
    );
    req.log.error(
      { in: req.inboundApi, out: req.outboundApi, path: req.path },
      err.message
    );
    throw err;
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  // This should happen somewhere else but addKey is guaranteed to run first.
  
  req.isStreaming = req.body.stream === true || req.body.stream === "true";
  req.body.stream = req.isStreaming !== undefined ? req.isStreaming : false;

  // Anthropic support has a special endpoint that accepts OpenAI-formatted
  // requests and translates them into Anthropic requests.  On this endpoint,
  // the requested model is an OpenAI one even though we're actually sending
  // an Anthropic request.
  // For such cases, ignore the requested model entirely.
  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.log.debug("Using an Anthropic key for an OpenAI-compatible request");
    assignedKey = keyPool.get("claude-v1");
  } else {
    assignedKey = keyPool.get(req.body.model);
  }

  req.key = assignedKey;
  req.log.info(
    {
      key: assignedKey.hash,
      model: req.body?.model,
      fromApi: req.inboundApi,
      toApi: req.outboundApi,
    },
    "Assigned key to request"
  );
  if (assignedKey.service === "anthropic") {
    proxyReq.setHeader("X-API-Key", assignedKey.key);
} else if (assignedKey.service == "palm") {
	proxyReq.setHeader("X-GOOG-API-KEY", assignedKey.key);
  } else {
	if (assignedKey.key.includes(";")) {

		proxyReq.setHeader("api-key", `${assignedKey.auth}`);
		proxyReq.setHeader("User-Agent", `OpenAI/v1 PythonBindings/0.28.1`);
		proxyReq.setHeader("Content-Type", `application/json`);
	} else {
		proxyReq.setHeader("Authorization", `Bearer ${assignedKey.key}`);
		if (assignedKey.org != "default") {
			const encodedOrg = encodeURIComponent(assignedKey.org);
			proxyReq.setHeader("OpenAI-Organization", `${encodedOrg}`);
		}
	}
  }
};
