import { fixRequestBody } from "http-proxy-middleware";
import type { ProxyRequestMiddleware } from ".";
import { config } from "../../../config";
import crypto from 'crypto';

export const finalizeBody: ProxyRequestMiddleware = (proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    let updatedBody = JSON.stringify(req.body);
	
    if (req.body.model === "text-bison-001" || req.body.model == "gemini-pro") {
		const { stream, ...bodyWithoutStream } = JSON.parse(updatedBody);
		updatedBody = JSON.stringify(bodyWithoutStream);
		let googleRequestURL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent`;
		console.log(req.body)
		if (req.body.model === "text-bison-001") {
			googleRequestURL = `https://generativelanguage.googleapis.com/v1beta/models/text-bison-001:generateContent`;
		}
		proxyReq.path = new URL(googleRequestURL).pathname + new URL(googleRequestURL).search;
		console.log(proxyReq.path)
	}
	
	
	
	if (req.key?.key.includes(";") && req.key?.specialMap != undefined) {
		const [url, apiKey] = req.key.key.split(";");
		const deployment = req.key.specialMap[req.body.model];
		
		const requestURL = `${url}/openai/deployments/${deployment}/chat/completions?api-version=2023-03-15-preview`;
		
		proxyReq.path = new URL(requestURL).pathname + new URL(requestURL).search;
		req.headers['Content-Type'] = 'application/json';
		req.headers['api-key'] = apiKey;
		req.headers['User-Agent'] = 'OpenAI/v1 PythonBindings/0.28.1';
		proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
		(req as any).rawBody = Buffer.from(updatedBody);
		fixRequestBody(proxyReq, req);
	
	}  else if (req.key?.service === "aws") {
      let accessKeyId = req.key.key ?? "nope";
      let secretAccessKey = req.key.secret ?? "nope";
      let region = req.key.region ?? "nope";
	  

      const { method, path, headers, body } = req;

      const canonicalRequest = `${method}\n${path}\n\nhost:bedrock-${region}.amazonaws.com\nx-amz-date:${headers['x-amz-date']}\n\nhost;x-amz-date\n${crypto.createHash('sha256').update(updatedBody).digest('hex')}`;
      const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
		
      const amzDate = new Date().toISOString().replace(/[\-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	  req.headers['X-Amz-Date'] = req.headers['x-amz-date'] || amzDate;
	  const datetime = headers['X-Amz-Date'] as string; // Assert that 'x-amz-date' is a string.
	  const date = datetime.substring(0, 8);
      const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${date}/${region}/bedrock/aws4_request\n${hashedCanonicalRequest}`;

      const signingKey = signatureKey(secretAccessKey, date, region, "bedrock");
      const signature = hmac(signingKey, stringToSign).toString('hex');
	  
	  req.headers['Authorization'] = `Bearer anything`;
      req.headers['X-Amz-Algorithm'] = `AWS4-HMAC-SHA256`;
	  req.headers['X-Amz-Signature'] = `${signature}`
	  req.headers['X-Amz-SignedHeaders'] = 'host'
	  req.headers['X-Amz-Credential'] = `${accessKeyId}/${date}/${region}/bedrock/aws4_request`
      req.headers['X-Amzn-Bedrock-Accept'] = "application/json";
	  req.headers['Action'] = "InvokeModel"
	  req.headers['Amz-Expires'] = '300'
	  fixRequestBody(proxyReq, req);
	  
    } else {
		proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
		(req as any).rawBody = Buffer.from(updatedBody);
		fixRequestBody(proxyReq, req);
	}
  }
};

// Helper function to calculate the signature key
function signatureKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  return kSigning;
}

// Helper function for HMAC calculation
function hmac(key: Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}