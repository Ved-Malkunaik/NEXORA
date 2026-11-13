# Deploy Nexora on Vercel (frontend and gateway together)

The whole dApp runs on Vercel's free (Hobby) plan: the React app as static files, and the gateway as one
Vercel Function at `/api/...` on the same domain. Its state (paid notes, spent-note markers, metering,
chat keys, rate-limit counts) lives in a free Upstash Redis database. Nothing runs on your PC.

```
browser ──► https://<app>.vercel.app           React app (dist/)
        └─► https://<app>.vercel.app/api/v1/*   gateway function ──► OpenRouter (free models)
                                                        │          └─► NEAR testnet (settle sessions)
                                                        └─► Upstash Redis (state)
```

## 1. Import the project

Vercel → **Add New → Project** → import the GitHub repository. Leave the framework as **Vite** and the
root directory as the repository root. `vercel.json` already sets the install command (it also installs
the gateway's dependencies), the `/api` routing and a 5-minute limit for streamed replies.

## 2. Add Redis

Project → **Storage → Create Database → Upstash (Redis)** → create it on the free plan and connect it to
this project. Vercel then adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project's environment
variables by itself. (If you create the database on upstash.com instead, add its REST URL and token as
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.)

## 3. Environment variables

Project → **Settings → Environment Variables**. None of these may start with `VITE_`: anything named
`VITE_…` is copied into the website's JavaScript, where every visitor could read it.

| Name | Value |
|---|---|
| `CONTRACT_ID` | `credits.vedd.testnet` |
| `GATEWAY_ACCOUNT_ID` | `gateway.vedd.testnet` |
| `GATEWAY_PRIVATE_KEY` | the settle-only key from `gateway/.env` |
| `NEAR_RPC_URL` | `https://rpc.testnet.fastnear.com` |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `OPENROUTER_MODELS` | e.g. `baidu/ernie-5.5-flash-preview:free,google/gemma-4-31b-it:free` (up to 3, tried in order) |
| `OPENROUTER_RPD` | `50` (or `1000` once the OpenRouter account has bought 10 credits) |

Do **not** set `VITE_GATEWAY_URL`: a production build talks to `/api` on its own domain. `ALLOWED_ORIGINS`
is not needed either, since the app and the gateway share one origin.

Then **Deployments → … → Redeploy** so the function picks the variables up.

## 4. Copy the existing notes (once)

The gateway's state from your PC (paid notes, spent-note markers) has to be copied into Redis, or notes
bought so far cannot be spent. Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` from Vercel (Storage → your
database → `.env.local` tab) into `gateway/.env` on your PC, then:

```bash
cd gateway
node --env-file=.env scripts/migrate-store.mjs
node --env-file=.env scripts/migrate-store.mjs --write
```

The first command only shows what would be copied. Running it twice is safe. Afterwards remove the two
`KV_…` lines from `gateway/.env` again if you want your local gateway to keep using its own file.

## 5. Check it

Open `https://<app>.vercel.app/api/v1/health`. It should show `"ok":true`, `"can_settle":true`,
`"model_live":true`, `"provider":"openrouter"` and `"storage":"redis"`.

Then the full flow on testnet, from your PC (needs near-cli-rs with your key in the keychain):

```bash
cd gateway
node --env-file=.env scripts/smoke.mjs <your-account>.testnet https://<app>.vercel.app/api
```

**Stop the gateway on your PC** once Vercel is live, so only one gateway settles sessions.

## How it behaves on Vercel

- **Abandoned sessions** (chatted, never ended) are settled by the gateway while their settlement window
  is open: within 15 minutes after expiry. With no always-on process, this cleanup runs in the background
  of ordinary requests, at most once a minute, plus a daily cron as a backstop. If nobody uses the app at
  all for the 15 minutes after a session expires, its owner can reclaim the full cap instead.
- **Cold starts:** the first request after a quiet period takes a second or two longer.
- **Free-model limits** are shared by every visitor (`OPENROUTER_RPD` a day, 18 a minute). When a limit is
  reached, the app says so and charges nothing. Listing a second model in `OPENROUTER_MODELS` helps when
  one model's provider is busy.
- **Logs:** Vercel → your project → **Logs** shows settlements (`settled #…`, `auto-settled …`) and errors.
