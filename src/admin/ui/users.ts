import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import { keyPool } from "../../key-management";
import * as userStore from "../../proxy/auth/user-store";
import {
  UserSchemaWithToken,
  parseSort, parseHide, 
  sortBy,
  paginate,
  UserSchema,
} from "../common";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/json") {
      cb(new Error("Invalid file type"));
    } else {
      cb(null, true);
    }
  },
});

router.get("/create-user", (req, res) => {
  const recentUsers = userStore
    .getUsers()
    .sort(sortBy(["createdAt"], false))
    .slice(0, 5);
  res.render("admin/create-user", {
    recentUsers,
    newToken: !!req.query.created,
  });
});

router.post("/create-user", (_req, res) => {
  userStore.createUser(_req.body.rateLimit,_req.body.promptLimit);
  return res.redirect(`/admin/manage/create-user?created=true`);
});

router.post("/create-temp-user", (_req, res) => {
  userStore.createTempUser(_req.body.promptLimit,_req.body.timeLimit,_req.body.rateLimit);
  return res.redirect(`/admin/manage/create-user?created=true`);
});

router.post("/update-page", (_req, res) => {
  config.page_body = atob(_req.body.base64_page);
  return res.redirect(`/admin`);
});


router.post("/update-promptinjections", (_req, res) => {
  config.promptInjections = JSON.parse(atob(_req.body.base64_pinject));
  return res.redirect(`/admin`);
});

router.post("/update-unauthresponse", (_req, res) => {
  config.responseOnUnauthorized = _req.body.base64_unauthresponse;
  return res.redirect(`/admin`);
});

router.post("/update-proxypass", (_req, res) => {
  if (config.gatekeeper == "proxy_key") {
	config.proxyKey = _req.body.proxy_password;
  }
  return res.redirect(`/admin`);
});


router.post("/recheck-keys", (_req, res) => {
  keyPool.recheck();
  
  // Replace redirect with notification 
  return res.redirect(`/admin`);
});

router.post("/add-keys", (_req, res) => {
  const keys = _req.body.keyInput.trim().replace(/[\n\r]/g, '')
  let keyArray: string[];
  let addedAmount = 0
  if (keys.includes(',')) {
    keyArray = keys.split(',');
  } else {
    keyArray = [keys];
  }
  for (const key of keyArray) {
     if (keyPool.addKey(key)) {
		 addedAmount+=1;
	 }
  }
  keyPool.recheck();
  return res.redirect(`/admin/manage/key-manager?addedKeys=`+addedAmount);
});


router.post("/delete-revoked-keys", (req, res) => {
  const keys = Object.values(keyPool.getKeysSafely());
  const revokedKeys = keys.filter(key => key.isRevoked === true);
  const revokedKeyHashes = revokedKeys.map(key => key.hash);
  let amountDeleted = 0
  for (const hash of revokedKeyHashes) {
	  keyPool.deleteKeyByHash(hash);
	  amountDeleted++;
  }
  return res.redirect(`/admin/manage/key-manager?deletedRevoked=`+amountDeleted);
});

router.post("/delete-outofquota-keys", (req, res) => {
  const keys = Object.values(keyPool.getKeysSafely());
  const overQuotaKeys = keys.filter(key => key.isOverQuota === true);
  const overQuotaHashes = overQuotaKeys.map(key => key.hash);
  let amountDeleted = 0
  for (const hash of overQuotaHashes) {
	  keyPool.deleteKeyByHash(hash);
	  amountDeleted++;
  }
  return res.redirect(`/admin/manage/key-manager?deletedRevoked=`+amountDeleted);
});




router.post("/delete-key/:key", (req, res) => {
  const keyHash = req.params.key;
  keyPool.deleteKeyByHash(keyHash)
  return res.redirect(`/admin/manage/key-manager?deleted=`+keyHash);
});

router.post("/export-keys-hashes", (_req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=keys-hashes.txt");
  res.setHeader("Content-Type", "application/text");
  
  
  const hashes = keyPool.getHashes();
  const text = hashes.join("\n");
  res.send(text);

});


router.get("/view-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).send("User not found");
  }
  res.render("admin/view-user", { user });
});


router.post("/edit-user/:token", (req, res) => {
  let user = userStore.getUser(req.params.token);
  
  if (!user) {
    return res.status(404).send("User not found");
  }
  
  const edit_type = req.body.toEdit
  const edit_value = req.body.valueOfEdit
  
  if (edit_type == "Token") {
    if (edit_value.length != 0) {
		userStore.updateToken(user,  edit_value);
		user = userStore.getUser(edit_value);
		if (!user) {
			return res.status(404).send("Token Change Failed");
		}
	}
	
  }
  
  if (edit_type == "Type") { // Other types in future ;v 
	if (edit_value == "normal") {
		user.type = "normal" 
	}
	else if (edit_value == "temp") {
		user.type = "temp" 
	}
  }
  
  if (edit_type === "Disabled Reason") {
    if (edit_value != null) {
	 user.disabledReason = edit_value;
    }
  }
  
  if (edit_type === "Rate Limit") {
	  const rateLimitValue = parseInt(edit_value);
	  if (!isNaN(rateLimitValue)) {
		user.rateLimit = rateLimitValue;
  }}
  
  if (edit_type === "Prompt Limit") {
	  const promptLimit = parseInt(edit_value);
	  if (!isNaN(promptLimit)) {
		user.promptLimit = promptLimit;
  }}
  
  if (edit_type === "Time Limit	") {
	  const timeLimit = parseInt(edit_value);
	  if (!isNaN(timeLimit)) {
		user.timeLimit = timeLimit;
  }}
  
  if (edit_type === "End Time Limit") {
	  const endTimeLimit = parseInt(edit_value);
	  if (!isNaN(endTimeLimit)) {
		user.endTimeLimit = endTimeLimit;
  }}
  
  if (edit_type === "Note") {
	  if (edit_value != null && edit_value != "") {
		user.note = edit_value;
  }}
  
  
  if (edit_type === "Claude") {
		user.allowClaude = Boolean(edit_value);
  }
  
  if (edit_type == "Gpt") {
		user.allowGpt = Boolean(edit_value);
  }
  
  if (edit_type == "Ai21") {
		user.allowAi21 = Boolean(edit_value);
  }
  
  if (edit_type == "Palm") {
	user.allowPalm = Boolean(edit_value);
  }


  res.render("admin/view-user", { user });
});

router.get("/list-users", (req, res) => {
  const sort = parseSort(req.query.sort) || ["promptGptCount", "lastUsedAt"];
  
  
  const requestedPageSize =
    Number(req.query.perPage) || Number(req.cookies.perPage) || 20;
  const perPage = Math.max(1, Math.min(1000, requestedPageSize));
  const users = userStore.getUsers().sort(sortBy(sort, false));

  const page = Number(req.query.page) || 1;
  const { items, ...pagination } = paginate(users, page, perPage);

  return res.render("admin/list-users", {
    sort: sort.join(","),
    users: items,
    ...pagination,
  });
});

function sortByKey(fields: string[], asc = true) {
  return (a: any, b: any) => {
    for (const field of fields) {
      const fieldParts = field.split('.'); // Split the field into nested property parts

      let valA = a;
      let valB = b;
      for (const part of fieldParts) {
        valA = valA[part];
        valB = valB[part];
      }

      if (valA !== valB) {
        // Always sort nulls to the end
        if (valA == null) return 1;
        if (valB == null) return -1;

        const result = valA < valB ? -1 : 1;
        return asc ? result : -result;
      }
    }
    return 0;
  };
}

router.get("/key-manager", (req, res) => {
  const sort = parseSort(req.query.sort) || ["org", "isGpt4", "isGpt432k", "isOverQuota","isRevoked"];
  const hide = parseHide(req.query.sort) || ["org", "isGpt4", "isGpt432k", "isOverQuota","isRevoked"];
  
  const keys = Object.values(keyPool.getKeysSafely()).sort(sortBy(sort, false));
  return res.render("admin/key-manager", { keys, });
});


router.get("/import-users", (req, res) => {
  const imported = Number(req.query.imported) || 0;
  res.render("admin/import-users", { imported });
});


router.post("/import-users", upload.single("users"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const data = JSON.parse(req.file.buffer.toString());

  data.users = data.users.map((user: userStore.User) => {
  const { ipPromptCount, allPromptCount, allTokenCountInput, allTokenCountOutput, ...newUser } = user;
  return newUser;
});
  const result = z.array(UserSchemaWithToken).safeParse(data.users);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  const upserts = result.data.map((user) => userStore.upsertUser(user));
  res.redirect(`/admin/manage/import-users?imported=${upserts.length}`);
});

router.get("/export-users", (_req, res) => {
  res.render("admin/export-users");
});

router.get("/other", (_req, res) => {
  res.render("admin/other");
});

router.get("/export-users.json", (_req, res) => {
  const users = userStore.getUsers();
  const usersWithoutIPs = users.map(({ ip, promptLimit, ...rest }) => ({
  ...rest,
  promptLimit: typeof promptLimit === 'number' ? promptLimit : parseInt(promptLimit || '0', 10)
}));
  res.setHeader("Content-Disposition", "attachment; filename=users.json");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ users: usersWithoutIPs }, null, 2));
});

router.get("/", (_req, res) => {
  res.render("admin/index", {
    isPersistenceEnabled: config.gatekeeperStore !== "memory",
  });
});



router.post("/reactivate-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).send("User not found");
  }
  userStore.upsertUser({
    token: user.token,
    disabledAt: 0,
    disabledReason: "",
  });
  return res.sendStatus(204);
});

router.post("/disable-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).send("User not found");
  }
  userStore.disableUser(req.params.token, req.body.reason);
  return res.sendStatus(204);
}); 
  
  
router.post("/delete-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) {
    return res.status(404).send("User not found");
  }
  userStore.deleteUser(user);
  return res.sendStatus(204);
}); 
  

export { router as usersUiRouter };
