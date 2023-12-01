import axios, { AxiosError, AxiosRequestConfig  } from "axios";
import { logger } from "../../logger";
import type { OpenAIKey, OpenAIKeyProvider } from "./provider";
import crypto from "crypto";
/** Minimum time in between any two key checks. */
const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
/**
 * Minimum time in between checks for a given key. Because we can no longer
 * read quota usage, there is little reason to check a single key more often
 * than this.
 **/
const KEY_CHECK_PERIOD = 60 * 60 * 1000; // 1 hour

const POST_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_SUBSCRIPTION_URL =
  "https://api.openai.com/dashboard/billing/subscription";
const GET_ORGANIZATION_URL =
  "https://api.openai.com/v1/organizations";
  
type GetModelsResponse = {
  data: [{ id: string }];
};

type GetModelsResponsev2 = {
  error: { code: string };
};

type GetSubscriptionResponse = {
  plan: { title: string };
  has_payment_method: boolean;
  soft_limit_usd: number;
  hard_limit_usd: number;
  system_hard_limit_usd: number;
};


type Organization= {
  object: string; 
  ID: string;
  created: number;
  title: string;
  name: string;
  personal: boolean;
  isdefault: boolean;
  role: boolean;
};


type OpenAIError = {
  error: { type: string; code: string; param: unknown; message: string };
  data: {};
};

type UpdateFn = typeof OpenAIKeyProvider.prototype.update;
type CreateFn = typeof OpenAIKeyProvider.prototype.createKey;


export class OpenAIKeyChecker {
  private readonly keys: OpenAIKey[];
  private log = logger.child({ module: "key-checker", service: "openai" });
  private timeout?: NodeJS.Timeout;
  private updateKey: UpdateFn;
  private createKey: CreateFn;
  
  private lastCheck = 0;

  constructor(keys: OpenAIKey[], updateKey: UpdateFn, createKey: CreateFn) {
    this.keys = keys;
    this.updateKey = updateKey;
	this.createKey = createKey;
	
  }

  public start() {
    this.log.info("Starting key checker...");
    this.scheduleNextCheck();
  }

  public stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  /**
   * Schedules the next check. If there are still keys yet to be checked, it
   * will schedule a check immediately for the next unchecked key. Otherwise,
   * it will schedule a check for the least recently checked key, respecting
   * the minimum check interval.
   **/
  private scheduleNextCheck() {
    const enabledKeys = this.keys.filter((key) => !key.isDisabled);
	enabledKeys.map((key) => this.getExtraKeys(key))

    if (enabledKeys.length === 0) {
      this.log.warn("All keys are disabled. Key checker stopping.");
      return;
    }

    // Perform startup checks for any keys that haven't been checked yet.
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    if (uncheckedKeys.length > 0) {
      // Check up to 12 keys at once to speed up startup.
      const keysToCheck = uncheckedKeys.slice(0, 12);

      this.log.info(
        {
          key: keysToCheck.map((key) => key.hash),
          remaining: uncheckedKeys.length - keysToCheck.length,
        },
        "Scheduling initial checks for key batch."
      );
      this.timeout = setTimeout(async () => {
		  
        const promises = keysToCheck.map((key) => this.checkKey(key));
        try {
          await Promise.all(promises);
        } catch (error) {
          this.log.error({ error }, "Error checking one or more keys.");
        }
        this.scheduleNextCheck();
      }, 250);
      return;
    }

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    // Don't check any individual key too often.
    // Don't check anything at all at a rate faster than once per 3 seconds.
    const nextCheck = Math.max(
      oldestKey.lastChecked + KEY_CHECK_PERIOD,
      this.lastCheck + MIN_CHECK_INTERVAL
    );

    this.log.debug(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck) },
      "Scheduling next check."
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
  }


  private async getOrganization(key: OpenAIKey) {
	  const payload = {
      model: "gpt-3.5-turbo",
      max_tokens: -1,
      messages: [{ role: "user", content: "" }],
    };
	
	if (!key.key.includes(";")) {
		const { headers, data } = await axios.post<OpenAIError>(
		  POST_CHAT_COMPLETIONS_URL,
		  payload,
		  {
			headers: {
				Authorization: `Bearer ${key.key}`,
				...(key.org !== 'default' ? { 'OpenAI-Organization': key.org } : {})
		},
			validateStatus: (status) => status === 400,
		  }
		);

		let orgName = headers["openai-organization"];
		
		if (orgName.match("user") || orgName.match("personal")) {
			orgName = "default"
		}
		
		const updates = {
		  org: orgName,
		};
		this.updateKey(key.hash, updates);

		// invalid_request_error is the expected error
		if (data.error.type !== "invalid_request_error") {
		  this.log.warn(
			{ key: key.hash, error: data },
			"Unexpected 400 error class while checking key; assuming key is valid, but this may indicate a change in the API."
		  );
		} 
	} else {
		const updates = {
		  org: "default",
		};
		this.updateKey(key.hash, updates);
		
	}
  }

  private async checkKey(key: OpenAIKey) {
    // It's possible this key might have been disabled while we were waiting
    // for the next check.
    if (key.isDisabled) {
      this.log.warn({ key: key.hash }, "Skipping check for disabled key.");
      this.scheduleNextCheck();
      return;
    }
	this.log.debug({ key: key.hash }, "Checking key for additional profiles...");
	this.log.debug({ key: key.hash }, "Checking key...");
    let isInitialCheck = !key.lastChecked;
    try {
      // We only need to check for provisioned models on the initial check.
      if (isInitialCheck) {
		
		
        const [/* subscription,*/ provisionedModels, livenessTest] =
          await Promise.all([
            // this.getSubscription(key),
            this.getProvisionedModels(key),
            this.testLiveness(key),
			this.getOrganization(key)
          ]
		  );
		  
		
		
        const updates = {
          isGpt4: provisionedModels.gpt4,
		  isGpt432k: provisionedModels.gpt432k,
		  isGpt4Turbo: provisionedModels.gpt4turbo,
		  specialMap: provisionedModels.specialMap,
          // softLimit: subscription.soft_limit_usd,
          // hardLimit: subscription.hard_limit_usd,
          // systemHardLimit: subscription.system_hard_limit_usd,
          isTrial: livenessTest.rateLimit <= 250,
          softLimit: 0,
          hardLimit: 0,
          systemHardLimit: 0,
        };
        this.updateKey(key.hash, updates);
      } else {
        // Provisioned models don't change, so we don't need to check them again
        const [/* subscription, */ _livenessTest] = await Promise.all([
          // this.getSubscription(key),
          this.testLiveness(key),
        ]);
        const updates = {
          // softLimit: subscription.soft_limit_usd,
          // hardLimit: subscription.hard_limit_usd,
          // systemHardLimit: subscription.system_hard_limit_usd,
          softLimit: 0,
          hardLimit: 0,
          systemHardLimit: 0,
        };
        this.updateKey(key.hash, updates);
      }
      this.log.info(
        { key: key.hash, hardLimit: key.hardLimit },
        "Key check complete."
      );
    } catch (error) {
      // touch the key so we don't check it again for a while
      this.updateKey(key.hash, {});
      this.handleAxiosError(key, error as AxiosError);
    }

    this.lastCheck = Date.now();
    // Only enqueue the next check if this wasn't a startup check, since those
    // are batched together elsewhere.
    if (!isInitialCheck) {
      // this.scheduleNextCheck();
    }
  }

  private async getProvisionedModels(
    key: OpenAIKey
  ): Promise<{ turbo: boolean; gpt4: boolean; gpt432k: boolean; gpt4turbo: boolean; specialMap: { [key: string]: string }} > {
	
	if (key.key.includes(";") == true){
		key.isSpecial = true;
		key.auth = key.key.split(";")[1]
		key.endpoint = key.key.split(";")[0]
	} 

	let opts = {}
	if (key.key.includes(";") == false) {
		opts = { headers: { Authorization: `Bearer ${key.key}`, } };
	} else {
		opts = { headers: { 'api-key': `${key.auth}`, 'Content-Type': 'application/json'} };
	}

	
	let turbo = false;
	let gpt4 = false;
	let gpt432k = false;
	let gpt4turbo = false;
	const specialMap: { [key: string]: string } = {};

	if (key.key.includes(";") == false) {
		let { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
		let models = data.data;
		turbo = models.some(({ id }) => id.startsWith("gpt-3.5"));
		gpt4 = models.some(({ id }) => id.startsWith("gpt-4"));
		gpt432k = models.some(({ id }) => id.startsWith("gpt-4-32k"));
		gpt4turbo = models.some(({ id }) => id.startsWith("gpt-4-1106"));
	} else {
		let data = {}
		const headers: AxiosRequestConfig['headers'] = {
		   'User-Agent': 'OpenAI/v1 PythonBindings/0.28.0', 
		  'Content-Type': 'application/json',
		  'api-key': key.auth,
		};
		
		try {
			const response = await axios.get(key.endpoint+"/openai/deployments?api-version=2023-03-15-preview", {headers});
			for (const index in response.data.data) {
				if (response.data.data[index].status == "succeeded") {
					specialMap[response.data.data[index].model] = response.data.data[index].id
					if (response.data.data[index].model == "gpt-4") {
						gpt4 = true 
					} else if (response.data.data[index].model == "gpt-4-32k") {
						gpt432k = true 
					} else if (response.data.data[index].model == "gpt-4-1106-preview") {
						gpt4turbo = true 
					}  else if (response.data.data[index].model.includes("gpt-3") == true) {
						turbo = true 
					}
					
					
				}
			}
		} catch(e){ 
			// console.log(e);
			// Invalid endpoint 	
		}

	
	}
	
    // We want to update the key's `isGpt4` flag here, but we don't want to
    // update its `lastChecked` timestamp because we need to let the liveness
    // check run before we can consider the key checked.

    // Need to use `find` here because keys are cloned from the pool.
    const keyFromPool = this.keys.find((k) => k.hash === key.hash)!;
    this.updateKey(key.hash, {
      isGpt4: gpt4,
	  isGpt432k: gpt432k,
	  isGpt4Turbo: gpt4turbo,
	  isSpecial: key.isSpecial,
	  endpoint: key.endpoint,
	  auth: key.auth,
      lastChecked: keyFromPool.lastChecked,
    });
    return { turbo, gpt4, gpt432k, gpt4turbo, specialMap };
  }
  
  
  
  
  private async getSubscription(key: OpenAIKey) {
    const { data } = await axios.get<GetSubscriptionResponse>(
      GET_SUBSCRIPTION_URL,
      { headers: { Authorization: `Bearer ${key.key}` } }
    );
    // See note above about updating the key's `lastChecked` timestamp.
    const keyFromPool = this.keys.find((k) => k.hash === key.hash)!;
    this.updateKey(key.hash, {
      isTrial: !data.has_payment_method,
      lastChecked: keyFromPool.lastChecked,
    });
    return data;
  }

  private handleAxiosError(key: OpenAIKey, error: AxiosError) {
    if (error.response && OpenAIKeyChecker.errorIsOpenAIError(error)) {
      const { status, data } = error.response;
		  if (status === 401) {
			if (key.key.includes(";") == false) {
			this.log.warn(
			  { key: key.hash, error: data },
			  "Key is invalid or revoked. Disabling key."
			);
			this.updateKey(key.hash, {
			  isDisabled: true,
			  isRevoked: true,
			  isGpt4: false,
			});
		}
      } else if (status === 429) {
        switch (data.error.type) {
          case "insufficient_quota":
          case "access_terminated":
          case "billing_not_active":
            const isOverQuota = data.error.type === "insufficient_quota";
            const isRevoked = !isOverQuota;
            const isGpt4 = isRevoked ? false : key.isGpt4;
            this.log.warn(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Key returned a non-transient 429 error. Disabling key."
            );
            this.updateKey(key.hash, {
              isDisabled: true,
              isRevoked,
              isOverQuota,
              isGpt4,
            });
            break;
          case "requests":
            // Trial keys have extremely low requests-per-minute limits and we
            // can often hit them just while checking the key, so we need to
            // retry the check later to know if the key has quota remaining.
            this.log.warn(
              { key: key.hash, error: data },
              "Key is currently rate limited, so its liveness cannot be checked. Retrying in fifteen seconds."
            );
            // To trigger a shorter than usual delay before the next check, we
            // will set its `lastChecked` to (NOW - (KEY_CHECK_PERIOD - 15s)).
            // This will cause the usual key check scheduling logic to schedule
            // the next check in 15 seconds. This also prevents the key from
            // holding up startup checks for other keys.
            const fifteenSeconds = 15 * 1000;
            const next = Date.now() - (KEY_CHECK_PERIOD - fifteenSeconds);
            this.updateKey(key.hash, { lastChecked: next });
            break;
          case "tokens":
            // Hitting a token rate limit, even on a trial key, actually implies
            // that the key is valid and can generate completions, so we will
            // treat this as effectively a successful `testLiveness` call.
            this.log.info(
              { key: key.hash },
              "Key is currently `tokens` rate limited; assuming it is operational."
            );
            this.updateKey(key.hash, { lastChecked: Date.now() });
            break;
          default:
            this.log.error(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Encountered unexpected rate limit error class while checking key. This may indicate a change in the API; please report this."
            );
            // We don't know what this error means, so we just let the key
            // through and maybe it will fail when someone tries to use it.
            this.updateKey(key.hash, { lastChecked: Date.now() });
        }
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered unexpected error status while checking key. This may indicate a change in the API; please report this."
        );
        this.updateKey(key.hash, { lastChecked: Date.now() });
      }
      return;
    }
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  /**
   * Tests whether the key is valid and has quota remaining. The request we send
   * is actually not valid, but keys which are revoked or out of quota will fail
   * with a 401 or 429 error instead of the expected 400 Bad Request error.
   * This lets us avoid test keys without spending any quota.
   * 
   * We use the rate limit header to determine whether it's a trial key.
   */
   
  public async getExtraKeys(key: OpenAIKey) {
	if (key.key.includes(";") == false) {
		const { data } = await axios.get(
		  GET_ORGANIZATION_URL,
		  {
			headers: { Authorization: `Bearer ${key.key}` }
		  }
		);
		if (Array.isArray(data.data)) {
			await data.data.forEach((item: any) => {
				if (item["is_default"] == false) {
					let orgName = item["name"]
					if (orgName.match("user") || orgName.match("personal")) {
						orgName = "default"
					}
					
					this.createKey({
						key: key.key,
						org: orgName, 
						service: "openai" as const,
						isGpt4: true,
						isGpt432k: false,
						isTrial: false,
						isDisabled: false,
						isRevoked: false,
						isOverQuota: false,
						softLimit: 0,
						hardLimit: 0,
						systemHardLimit: 0,
						usage: 0,
						lastUsed: 0,
						lastChecked: 0,
						promptCount: 0,
						// Changing hash to uid sorry but annoying to work with if one key can have multiple profiles 
						hash: `oai-${crypto
						  .createHash("sha256")
						  .update(key.key)
						  .digest("hex")+"-org"}`,
						rateLimitedAt: 0,
						rateLimitRequestsReset: 0,
						rateLimitTokensReset: 0,
					  });
				}
			})
		} 
	}
    return true;
  }
  

   
  private async testLiveness(key: OpenAIKey): Promise<{ rateLimit: number }> {
	if (!key.key.includes(";")) {
		const payload = {
		  model: "gpt-3.5-turbo",
		  max_tokens: -1,
		  messages: [{ role: "user", content: "" }],
		};
		const { headers, data } = await axios.post<OpenAIError>(
		  POST_CHAT_COMPLETIONS_URL,
		  payload,
		  {
			headers: {
				Authorization: `Bearer ${key.key}`,
				...(key.org !== 'default' ? { 'OpenAI-Organization': key.org } : {})
		},
			validateStatus: (status) => status === 400,
		  }
		);
		
		
		const rateLimitHeader = headers["x-ratelimit-limit-requests"];
		const rateLimit = parseInt(rateLimitHeader) || 3500; // trials have 200

		// invalid_request_error is the expected error
		if (data.error.type !== "invalid_request_error") {
		  this.log.warn(
			{ key: key.hash, error: data },
			"Unexpected 400 error class while checking key; assuming key is valid, but this may indicate a change in the API."
		  );
		}
		return { rateLimit };
	} else {
		const rateLimit = 500;
		return { rateLimit }
	}
  }

  static errorIsOpenAIError(
    error: AxiosError
  ): error is AxiosError<OpenAIError> {
    const data = error.response?.data as any;
    return data?.error?.type;
  }
}
