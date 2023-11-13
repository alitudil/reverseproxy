import { fixRequestBody } from "http-proxy-middleware";
import type { ProxyRequestMiddleware } from ".";
import { config } from "../../../config";
import crypto from 'crypto';



export const finalizeBody: ProxyRequestMiddleware = (proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    let updatedBody = JSON.stringify(req.body);

    if (req.body.model === "text-bison-001") {
      const { stream, ...bodyWithoutStream } = JSON.parse(updatedBody);
      updatedBody = JSON.stringify(bodyWithoutStream);
    }

    if (req.key?.service === "aws") {
      let accessKeyId = req.key.key ?? "nope";
      let secretAccessKey = req.key.secret ?? "nope";
      let region = req.key.region ?? "nope";
      const { method, path, headers, body } = req;

      const canonicalRequest = `${method}\n${path}\n\nhost:bedrock-${region}.amazonaws.com\nx-amz-date:${headers['x-amz-date']}\n\nhost;x-amz-date\n${crypto.createHash('sha256').update(updatedBody).digest('hex')}`;
      const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
		
      const amzDate = new Date().toISOString().replace(/[\-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	  req.headers['x-amz-date'] = req.headers['x-amz-date'] || amzDate;
	  const datetime = headers['x-amz-date'] as string; // Assert that 'x-amz-date' is a string.
	  const date = datetime.substring(0, 8);
      const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${date}/${region}/bedrock/aws4_request\n${hashedCanonicalRequest}`;

      const signingKey = signatureKey(secretAccessKey, date, region, "bedrock");
      const signature = hmac(signingKey, stringToSign).toString('hex');

      req.headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${date}/${region}/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;
      req.headers['x-amzn-bedrock-accept'] = "application/json";
    }

    proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
    (req as any).rawBody = Buffer.from(updatedBody);
    fixRequestBody(proxyReq, req);
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