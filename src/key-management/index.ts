import { OPENAI_SUPPORTED_MODELS, OpenAIModel } from "./openai/provider";
import {
  ANTHROPIC_SUPPORTED_MODELS,
  AnthropicModel,
} from "./anthropic/provider";
import {
  PALM_SUPPORTED_MODELS,
  PalmModel,
} from "./palm/provider";
import {
  AI21_SUPPORTED_MODELS,
  Ai21Model,
} from "./ai21/provider";
import {
  AWS_SUPPORTED_MODELS,
  AwsModel,
} from "./aws/provider";

import { KeyPool } from "./key-pool";

export type AIService = "openai" | "anthropic" | "palm" | "ai21" | "aws";
export type Model = OpenAIModel | AnthropicModel | PalmModel  | Ai21Model | AwsModel;

export interface Key {
  /** The API key itself. Never log this, use `hash` instead. */
  readonly key: string;
  org: string;
  /** The service that this key is for. */
  service: AIService;
  /** Whether this is a free trial key. These are prioritized over paid keys if they can fulfill the request. */
  isTrial: boolean;
  /** Whether this key has been provisioned for GPT-4. */
  isGpt4: boolean;
  /** Whether this key has been provisioned for GPT-4 32k. */  
  isGpt432k: boolean;
  /** Whether this key is currently disabled, meaning its quota has been exceeded or it has been revoked. */
  isDisabled: boolean;
  isPozzed?: boolean;
  /** Anthropic specific if keys is totally invalid */
  isRevoked: boolean;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** The time at which this key was last checked. */
  lastChecked: number;
  /** Hash of the key, for logging and to find the key in the pool. */
  hash: string;
  
  secret?: string;
  region?:string;
}

/*
KeyPool and KeyProvider's similarities are a relic of the old design where
there was only a single KeyPool for OpenAI keys. Now that there are multiple
supported services, the service-specific functionality has been moved to
KeyProvider and KeyPool is just a wrapper around multiple KeyProviders,
delegating to the appropriate one based on the model requested.

Existing code will continue to call methods on KeyPool, which routes them to
the appropriate KeyProvider or returns data aggregated across all KeyProviders
for service-agnostic functionality.
*/

export interface KeyProvider<T extends Key = Key> {
  readonly service: AIService;
  init(): void;
  recheck(): void;
  addKey(keyValue: string): boolean; 
  deleteKeyByHash(keyHash: string): boolean;
  getHashes(): string[];
  getAllKeys(): Object;
  get(model: Model): T;
  list(): Omit<T, "key">[];
  disable(key: T): void;
  update(hash: string, update: Partial<T>): void;
  available(): number;
  anyUnchecked(): boolean;
  incrementPrompt(hash: string): void;
  getLockoutPeriod(model: Model): number;
  activeLimitInUsd(options?: Record<string, unknown>): string;
  markRateLimited(hash: string): void;
}

export const keyPool = new KeyPool();
export const SUPPORTED_MODELS = [
  ...OPENAI_SUPPORTED_MODELS,
  ...ANTHROPIC_SUPPORTED_MODELS,
  ...PALM_SUPPORTED_MODELS,
  ...AI21_SUPPORTED_MODELS,
  ...AWS_SUPPORTED_MODELS,
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
export { OPENAI_SUPPORTED_MODELS, ANTHROPIC_SUPPORTED_MODELS, AI21_SUPPORTED_MODELS };
export { AnthropicKey } from "./anthropic/provider";
export { OpenAIKey } from "./openai/provider";
export { PalmKey } from "./palm/provider";
export { Ai21Key } from "./ai21/provider";
export { AwsKey } from "./aws/provider";