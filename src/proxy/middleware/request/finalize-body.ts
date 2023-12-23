import { fixRequestBody } from "http-proxy-middleware";
import type { ProxyRequestMiddleware } from ".";
import { config } from "../../../config";
import crypto from 'crypto';

export const finalizeBody: ProxyRequestMiddleware = (proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    let updatedBody = JSON.stringify(req.body);
	
    if (req.body.model.includes("gemini")) {
		const { stream, ...bodyWithoutStream } = JSON.parse(updatedBody);
		updatedBody = JSON.stringify(bodyWithoutStream);
		const isStream = JSON.parse(req.newRequest.body).stream 
		const googleRequestURL = `https://generativelanguage.googleapis.com/v1beta/models/${req.body.model}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
		
		proxyReq.path = new URL(googleRequestURL).pathname + new URL(googleRequestURL).search;
	} else if (req.body.model === "chat-bison-001") {
		const { stream, tools, ...bodyWithoutStream } = JSON.parse(updatedBody);
		updatedBody = JSON.stringify(bodyWithoutStream);
		const isStream = false
		const googleRequestURL = `https://generativelanguage.googleapis.com/v1/models/${req.body.model}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
		
		proxyReq.path = new URL(googleRequestURL).pathname + new URL(googleRequestURL).search;
		proxyReq.write(updatedBody);
		return
	}
	
	if (req.key?.isAws) {
		let { model, stream, prompt, ...otherProps } = req.body;
		const key = req.key.key 
		const awsSecret = req.key.awsSecret || ""
		const awsRegion = req.key.awsRegion || ""
	
		const requestURL = `/model/${req.body.model}/invoke${stream ? "-with-response-stream" : ""}`;
		req.signedRequest.hostname = requestURL;
		delete req.signedRequest.headers['content-length'];

		proxyReq.getRawHeaderNames().forEach(proxyReq.removeHeader.bind(proxyReq));
		Object.entries(req.signedRequest.headers).forEach(([key, value]) => {
		proxyReq.setHeader(key, value);
	  });
		proxyReq.removeHeader('content-length'); // Remove 'content-length' header
		proxyReq.path = req.signedRequest.path;

		proxyReq.write(req.signedRequest.body);
		return 
	} else if (req.key?.key.includes(";") && req.key?.specialMap != undefined) {
		if (req.key?.specialMap != undefined) {
			const deployment = req.key.specialMap[req.body.model];
			
			
			const requestURL = `${req.key.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2023-03-15-preview`;
			req.newRequest.hostname = requestURL;
			proxyReq.path = new URL(requestURL).pathname + new URL(requestURL).search;
			req.headers['Content-Type'] = 'application/json';
			req.headers['api-key'] = req.key.auth;
			req.headers['User-Agent'] = 'OpenAI/v1 PythonBindings/0.28.1';
			proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
			(req as any).rawBody = Buffer.from(updatedBody);
			fixRequestBody(proxyReq, req);
		}  
    } else {
		proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
		(req as any).rawBody = Buffer.from(updatedBody);
		fixRequestBody(proxyReq, req);
	}
  }
};


