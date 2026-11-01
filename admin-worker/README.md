# wd71-admin-api

This Cloudflare Worker is the backend for https://webdesigner71.com/admin/.
It handles Google sign-in, sends an approval email to ADMIN_EMAIL, and issues session tokens.

**Endpoints** (CORS: webdesigner71.com, www.webdesigner71.com, http://localhost:*)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/google` `{credential}` | Google ID token | Verifies the RS256 signature against Google JWKS and checks iss, aud, exp and email_verified. The response is `{status:"pending"}`, `{status:"rejected"}` or `{status:"approved", token, user}`. |
| GET | `/approve?email&exp&sig`, `/reject?…` | HMAC link (7 days) | Shows a confirmation page and changes nothing. |
| POST | `/approve`, `/reject` (form) | HMAC link | Applies the decision. |
| GET | `/me` | Bearer | Returns the current user. |
| GET | `/admin/users` | Bearer (approved) | Lists all users. |
| POST | `/admin/users/:email/approve\|reject\|delete` | Bearer (ADMIN_EMAIL only) | Manages users. |

- Session tokens are HS256 JWTs signed with SESSION_SECRET and last 12 hours.
- User status is re-checked in KV on every request, so rejecting or deleting a user cuts off their access immediately.

See [SETUP.md](SETUP.md) for deployment. No secrets are stored in this folder; they're set with `wrangler secret put`.
