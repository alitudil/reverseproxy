import { AnthropicKey, Key } from "../../../key-management";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

/**
 * Some keys require the prompt to start with `\n\nHuman:`. There is no way to
 * know this without trying to send the request and seeing if it fails. If a
 * key is marked as requiring a preamble, it will be added here.
 */
export const addAnthropicPreamble: ProxyRequestMiddleware = (
  _proxyReq,
  req
) => {
  if (!isCompletionRequest(req) || req.key?.service !== "anthropic") {
    return;
  }

  let preamble = "";
  let prompt = req.body.prompt;
  assertAnthropicKey(req.key);

  req.log.info(
    {
      requiresPreamble: req.key.requiresPreamble,
      inboundPrompt: prompt,
    },
    "Checking if Anthropic key requires preamble"
  );

  if (req.key.requiresPreamble) {
    preamble = prompt.startsWith("\n\nHuman:") ? "" : "\n\nHuman:";
    req.log.info({ key: req.key.hash, preamble }, "Adding preamble to prompt");

    // add assistant at the end of the prompt, but only if the last chat "turn"
    // not already an assistant turn
    const humanIndex = prompt.lastIndexOf("\n\nHuman:");
    const assistantIndex = prompt.lastIndexOf("\n\nAssistant:");
    req.log.info(
      { humanIndex, assistantIndex },
      "Checking if assistant postamble is needed"
    );
    if (humanIndex > assistantIndex) {
      prompt += "\n\nAssistant:";
      req.log.info("Adding assistant postamble to prompt");
    }
  }
  req.body.prompt = preamble + prompt;
};

function assertAnthropicKey(key: Key): asserts key is AnthropicKey {
  if (key.service !== "anthropic") {
    throw new Error(`Expected an Anthropic key, got '${key.service}'`);
  }
}
