import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../config";
import { logger } from "../../logger";
import axios, { AxiosError } from "axios";

// AWS
export const AWS_SUPPORTED_MODELS = [
  "anthropic.claude-v1.3",
  "anthropic.claude-v2"
] as const;
export type AwsModel = (typeof AWS_SUPPORTED_MODELS)[number];

export type AwsKeyUpdate = Omit<
  Partial<AwsKey>,
  | "key"
  | "secret"
  | "region"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

export interface AwsKey extends Key {
  readonly service: "aws";
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
  isRevoked: boolean;
  isPozzed: boolean;
  
  /** Aws specific **/ 
  secret: string; 
  region: string; 
  /**
   * Whether this key requires a special preamble.  For unclear reasons, some
   * AWS keys will throw an error if the prompt does not begin with a
   * message from the user, whereas others can be used without a preamble. This
   * is despite using the same API endpoint, version, and model.
   * When a key returns this particular error, we set this flag to true.
   */
  requiresPreamble: boolean;
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 2000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class AwsKeyProvider implements KeyProvider<AwsKey> {
  readonly service = "aws";

  private keys: AwsKey[] = [];
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.awsKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "AWS_KEY is not set. AWS API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const keyString of bareKeys) {
	  const [key, secret, region] = keyString.split(":");
      const newKey: AwsKey = {
        key,
		secret,
		region,
		org: "None",
        service: this.service,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false, 
		isPozzed: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        requiresPreamble: false,
        hash: `aws-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
	  
    }
	
    this.log.info({ keyCount: this.keys.length }, "Loaded AWS keys.");
  }
  
  public deleteKeyByHash(keyHash: string) {
	  const keyIndex = this.keys.findIndex((key) => key.hash === keyHash);
	  if (keyIndex === -1) {
		return false; // Key Not found 
	  }
	  this.keys.splice(keyIndex, 1);
	  return true; // Key successfully deleted
  }
  
  public addKey(keyValue: string) {
	  const isDuplicate = this.keys.some((key) => key.key === keyValue);
	  if (isDuplicate) {
		return false;
	  }
	  const [key, secret, region] = keyValue.split(":");
	  const newKey: AwsKey = {
        key: key,
		secret: secret,
		region: region,
		org: "None",
        service: this.service,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false, 
		isPozzed: false, 
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        requiresPreamble: false,
        hash: `aws-${crypto
          .createHash("sha256")
          .update(keyValue)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
	  return true 
  }
  
  // change any > propper type 
  private async checkValidity(key: any) {
	  const payload =  { } // Make payload 
	  try{
		// Write checker 
	  } catch (error) {
		// Write error checker 
	  }
  }
  
  public init() {
    // Simple checker Type of keys 
	for (const key of this.keys) {
		const promises = this.keys.map(key => this.checkValidity(key));
		return Promise.all(promises);
	}
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: AwsModel) {
    // Currently, all AWS keys have access to all models. This will almost
    // certainly change when they move out of beta later this year.
    const availableKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked);
    if (availableKeys.length === 0) {
      throw new Error("No AWS keys available.");
    }

    // (largely copied from the OpenAI provider, without trial key support)
    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. If all keys were rate limited recently, select the least-recently
    //       rate limited key.
    // 2. Keys which have not been used in the longest time

    const now = Date.now();

    const keysByPriority = availableKeys.sort((a, b) => {
      const aRateLimited = now - a.rateLimitedAt < RATE_LIMIT_LOCKOUT;
      const bRateLimited = now - b.rateLimitedAt < RATE_LIMIT_LOCKOUT;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }
      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;
    selectedKey.rateLimitedAt = now;
    // Intended to throttle the queue processor as otherwise it will just
    // flood the API with requests and we want to wait a sec to see if we're
    // going to get a rate limit error on this key.
    selectedKey.rateLimitedUntil = now + KEY_REUSE_DELAY;
    return { ...selectedKey };
  }

  public disable(key: AwsKey) {
    const keyFromPool = this.keys.find((k) => k.key === key.key);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AwsKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, update);
  }
  
  public getAllKeys() {
	  const safeKeyList = this.keys;
	  return safeKeyList
  }

  public recheck() {
	 // AWS Doesn't check keys so just put them back into active kes 
	 this.keys.forEach((key) => {
			key.isDisabled = false;
	 });
	 this.init();
  }
  
  public getHashes() {
	let x: string[] = [];
	
	return x;
  }
  
  public available() {
    return this.keys.filter((k) => !k.isDisabled && !k.isRevoked).length;
  }

  // No key checker for AWS
  public anyUnchecked() {
    return false;
  }

  public incrementPrompt(hash?: string) {
    const key = this.keys.find((k) => k.hash === hash);
    if (!key) return;
    key.promptCount++;
  }

  public getLockoutPeriod(_model: AwsModel) {
    const activeKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked);
    // Don't lock out if there are no keys available or the queue will stall.
    // Just let it through so the add-key middleware can throw an error.
    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((k) => now < k.rateLimitedUntil);
    const anyNotRateLimited = rateLimitedKeys.length < activeKeys.length;

    if (anyNotRateLimited) return 0;

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((k) => k.rateLimitedUntil - now)
    );
    return timeUntilFirstReady;
  }

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve, so all we can do is wait a bit and try
   * again. We will lock the key for 2 seconds after getting a 429 before
   * retrying in order to give the other requests a chance to finish.
   */
  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public activeLimitInUsd() {
    return "∞";
  }
}
