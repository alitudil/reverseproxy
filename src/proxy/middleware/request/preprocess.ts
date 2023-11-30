import { RequestHandler } from "express";
import { handleInternalError } from "../common";
import {
  RequestPreprocessor,
  checkContextSize,
  setApiFormat,
  transformOutboundPayload,
} from ".";

/**
 * Returns a middleware function that processes the request body into the given
 * API format, and then sequentially runs the given additional preprocessors.
 */
type RequestPreprocessorOptions = {
  /**
   * Functions to run before the request body is transformed between API
   * formats. Use this to change the behavior of the transformation, such as for
   * endpoints which can accept multiple API formats.
   */
  beforeTransform?: RequestPreprocessor[];
  /**
   * Functions to run after the request body is transformed and token counts are
   * assigned. Use this to perform validation or other actions that depend on
   * the request body being in the final API format.
   */
  afterTransform?: RequestPreprocessor[];
};

 
export const createPreprocessorMiddleware = (
  apiFormat: Parameters<typeof setApiFormat>[0],
  { beforeTransform, afterTransform }: RequestPreprocessorOptions = {}
): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat(apiFormat),
	...(beforeTransform ?? []),
    transformOutboundPayload,
    checkContextSize,
    ...(afterTransform ?? []),
  ];

  return async (...args) => executePreprocessors(preprocessors, args);
};

async function executePreprocessors(
  preprocessors: RequestPreprocessor[],
  [req, res, next]: Parameters<RequestHandler>
) {
  try {
    for (const preprocessor of preprocessors) {
      await preprocessor(req);
    }
    next();
  } catch (error) {

    // If the requested has opted into streaming, the client probably won't
    // handle a non-eventstream response, but we haven't initialized the SSE
    // stream yet as that is typically done later by the request queue. We'll
    // do that here and then call classifyErrorAndSend to use the streaming
    // error handler.
    const { stream } = req.body;
    const isStreaming = stream === "true" || stream === true;
    if (isStreaming && !res.headersSent) {
    }
  }
}