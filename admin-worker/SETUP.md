# WebDesigner71 admin panel — owner setup

Pieces:
- **Frontend:** `admin/index.html` in the GitHub Pages repo, served at https://webdesigner71.com/admin/
- **Backend:** this Cloudflare Worker (`wd71-admin-api`), meant to run at `https://api.webdesigner71.com`
  (or `https://wd71-admin-api.<subdomain>.workers.dev`)
- **Storage:** the Workers KV namespace `USERS`
- **Email:** the Resend HTTP API

## 1. Google OAuth client ID
1. Go to https://console.cloud.google.com/ and create or select a project.
2. Open **APIs & Services → OAuth consent screen**:
   - Choose External.
   - App name: WebDesigner71 Admin.
   - Support email: your Gmail.
   - Publish the app. Only basic profile and email scopes are used, so no verification is needed.
3. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins:**
     - `https://webdesigner71.com`
     - `https://www.webdesigner71.com`
     - (optional, for testing) `http://localhost:5500`
   - Leave Authorized redirect URIs empty. The popup flow doesn't use them.
4. Copy the client ID (`xxxx.apps.googleusercontent.com`) into **both** places:
   - `admin/index.html` → `const GOOGLE_CLIENT_ID = "..."`
   - `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`

## 2. Resend (approval emails)
1. Sign up at https://resend.com with **the admin Gmail** (`sohelhoo@gmail.com`, or whatever ADMIN_EMAIL is).
   The default sender `onboarding@resend.dev` can only deliver to the account owner's own address.
2. Go to **API Keys → Create API key** (permission: Sending access) and copy it. You'll need it in step 4.
3. (Optional, later) Verify the domain `webdesigner71.com` in Resend, then set `EMAIL_FROM` to something like
   `WebDesigner71 <admin@webdesigner71.com>`.

## 3. Cloudflare API token (if deploying with a token instead of `wrangler login`)
Go to My Profile → API Tokens → Create Custom Token with:
- Account → **Workers Scripts: Edit**
- Account → **Workers KV Storage: Edit**
- Account → **Account Settings: Read** (lets wrangler look up the account)
- Zone `webdesigner71.com` → **Workers Routes: Edit**
- Zone `webdesigner71.com` → **DNS: Edit** (needed for the `api.` custom domain)
- User → **User Details: Read** (optional; makes `wrangler whoami` work)

Then run `export CLOUDFLARE_API_TOKEN=...` in your shell. Don't commit the token.

## 4. Deploy
This needs Node.js 22 or newer.
```bash
cd wd71-admin-worker            # or admin-worker/ in the site repo
npm install

npx wrangler kv namespace create USERS
#   -> paste the printed id into wrangler.jsonc  kv_namespaces[0].id

# Secrets: you'll be prompted for each value (nothing appears in shell history)
openssl rand -hex 32            # run twice and use the outputs for the next two
npx wrangler secret put SESSION_SECRET
npx wrangler secret put APPROVAL_SECRET
npx wrangler secret put RESEND_API_KEY

# Custom domain: uncomment the "routes" block in wrangler.jsonc
#   { "pattern": "api.webdesigner71.com", "custom_domain": true }
# Wrangler creates the api.webdesigner71.com DNS record itself; no other records are touched.

npx wrangler deploy
curl https://api.webdesigner71.com/     # -> {"ok":true,...}
```
If you use the workers.dev URL instead, set `API_BASE` in `admin/index.html` to that URL.

## 5. Publish the frontend
1. Edit `admin/index.html` with the real `GOOGLE_CLIENT_ID` and `API_BASE`.
2. Commit and push to `main`. GitHub Pages serves it at https://webdesigner71.com/admin/

## 6. First login
1. Open https://webdesigner71.com/admin/ and click **Continue with Google** using ADMIN_EMAIL. That account is approved automatically.
2. Anyone else who signs in becomes **pending**, and ADMIN_EMAIL gets an Approve / Reject email.
3. Clicking a link opens a confirmation page; press the button to apply it. Pending, approved and rejected users can also be managed from the panel.

## Local testing
```bash
npm install
npm test        # starts `wrangler dev --local` and runs 39 end-to-end checks
```
The test writes a temporary `.dev.vars` with `TEST_MODE=1` and a locally generated JWKS, so Google tokens can be faked.
The Worker only honours `TEST_MODE` when the request host is `localhost` or `127.0.0.1`, so it has no effect on a deployed Worker.
Never set `TEST_MODE` as a production var anyway.
When `RESEND_API_KEY` is missing, the approval email (with its links) is written to the log instead of being sent.
