#!/usr/bin/env node
// One-time helper: exchange a Dropbox app key/secret for a long-lived
// refresh token to use in CI (GitHub Actions secrets).
//
// Usage:
//   DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... node scripts/dropbox-auth.mjs
// or just run `npm run auth` and paste the values when asked.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SCOPES = ["sharing.read", "files.content.read", "files.metadata.read"];

async function main() {
  const rl = readline.createInterface({ input, output });

  const appKey = process.env.DROPBOX_APP_KEY || (await rl.question("Dropbox App key: ")).trim();
  const appSecret =
    process.env.DROPBOX_APP_SECRET || (await rl.question("Dropbox App secret: ")).trim();

  const authUrl =
    "https://www.dropbox.com/oauth2/authorize?" +
    new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      token_access_type: "offline",
      scope: SCOPES.join(" "),
    }).toString();

  console.log("\n1. Open this URL, approve access, and copy the code shown:\n");
  console.log("   " + authUrl + "\n");

  const code = (await rl.question("2. Paste the authorization code here: ")).trim();
  rl.close();

  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    console.error(`\nToken exchange failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const json = await res.json();
  if (!json.refresh_token) {
    console.error("\nNo refresh_token returned. Response:", json);
    process.exit(1);
  }

  console.log("\n✅ Success! Add these as GitHub repository secrets:\n");
  console.log(`   DROPBOX_APP_KEY       = ${appKey}`);
  console.log(`   DROPBOX_APP_SECRET    = ${appSecret}`);
  console.log(`   DROPBOX_REFRESH_TOKEN = ${json.refresh_token}`);
  console.log("\n(Optional) DROPBOX_SHARED_LINK if your folder link differs from the default.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
