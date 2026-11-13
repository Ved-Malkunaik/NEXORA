# Host the Nexora gateway on Oracle Cloud (Always Free)

The gateway runs on a small VM in Oracle's data centre, 24/7, with your PC switched off. The app on
Vercel talks to it over HTTPS. Cost: nothing, on the Always Free tier.

You do steps 1–3 in the Oracle console (they need your account). Steps 4–6 are a few commands.
Step 7 connects Vercel.

## 1. Create the account

Sign up at <https://signup.cloud.oracle.com>. Oracle asks for a card to verify identity; Always Free
resources are not charged. Pick a home region close to you (it cannot be changed later).

## 2. Create the VM

Console → **Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Image | **Canonical Ubuntu 24.04** (Change image → Ubuntu) |
| Shape | **VM.Standard.E2.1.Micro** (Change shape → Specialty and previous generation). It is marked "Always Free-eligible" |
| Networking | Keep the default new VCN and public subnet. **Assign a public IPv4 address: Yes** |
| SSH keys | **Generate a key pair for me → Save private key**. Keep that file safe; it is the only way in |

Create it and wait until it is **Running**. Copy its **Public IP address**.

> If the Micro shape says "out of capacity", try another availability domain in the same form, or try
> again later. The Ampere (ARM) A1 shape is also Always Free and works the same way.

## 3. Open ports 80 and 443

Console → the instance → **Primary VNIC → Subnet → Security → Security lists → Default security list
→ Add ingress rules**. Add two rules:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Port 80 is only used to get the HTTPS certificate. Do **not** open 8787: the gateway listens on the VM
itself and is reached only through HTTPS.

## 4. Copy your config and data to the VM

On your PC (PowerShell or Git Bash), from the project folder. Replace `KEY` with the private key file
from step 2 and `IP` with the VM's public IP.

```bash
scp -i KEY gateway/.env ubuntu@IP:~/nexora.env
```

```bash
scp -i KEY -r gateway/.data ubuntu@IP:~/nexora-data
```

`.data` holds the paid-notes list, the spent-note markers and open-session metering. Copying it keeps
notes that were already bought spendable. On Windows, if `ssh` complains the key's permissions are too
open, right-click the key → Properties → Security, and leave only your own user with access.

**Before copying**, edit `gateway/.env` on your PC:

- Put in your **OpenRouter API key**: `OPENROUTER_API_KEY=sk-or-...`. If the file still has a `NEARAI_API_KEY`
  line, delete it, and revoke that key at <https://cloud.near.ai> since it was exposed earlier.
- Add `ALLOWED_ORIGINS=` followed by your Vercel address once you know it (step 7), for example
  `ALLOWED_ORIGINS=https://nexora.vercel.app`: exactly as the browser shows it, with `https://` and no
  trailing slash. Several addresses are comma-separated.

## 5. Run the setup script on the VM

```bash
ssh -i KEY ubuntu@IP
```

Then, on the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/Ved-Malkunaik/NEXORA/main/deploy/oracle/setup.sh -o setup.sh && bash setup.sh
```

The script installs Node 22 and Caddy, imports `~/nexora.env` and `~/nexora-data` from step 4, puts the code in `/opt/nexora`, runs the gateway as a service
that restarts on crashes and reboots, gets an HTTPS certificate, and opens the VM's own firewall
(Oracle's Ubuntu images block 80/443 even after step 3). At the end it prints:

```
VITE_GATEWAY_URL=https://<ip-with-dashes>.sslip.io
```

`sslip.io` is a free DNS name that points at your IP, so you get a real certificate without buying a
domain. To use your own domain instead, point an A record at the IP and run `bash setup.sh your.domain`.

## 6. Check it

From your PC or any browser:

```
https://<ip-with-dashes>.sslip.io/v1/health
```

It should show `"ok":true`, `"can_settle":true`, `"model_live":true` and `"provider":"openrouter"`.

**Stop the gateway on your PC now.** Two gateways with different copies of the notes and metering
would disagree.

## 7. Connect Vercel

Vercel → your project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `VITE_GATEWAY_URL` | the `https://…sslip.io` address from step 5 |

Then **Deployments → … → Redeploy** (Vite reads this at build time, so a redeploy is required).

If `ALLOWED_ORIGINS` did not have your Vercel address yet, add it now on the VM:

```bash
nano /opt/nexora/gateway/.env
```

```bash
sudo systemctl restart nexora-gateway
```

Open your Vercel site, connect a wallet, and go to **Settings → Gateway**: it should say **Ready**.

## Day to day

| Task | Command (on the VM) |
|---|---|
| Is it running? | `sudo systemctl status nexora-gateway` |
| Live logs | `sudo journalctl -u nexora-gateway -f` |
| Update to the latest code on GitHub | `bash /opt/nexora/deploy/oracle/setup.sh` |
| Change settings | `nano /opt/nexora/gateway/.env` then `sudo systemctl restart nexora-gateway` |
| Back up notes and metering | from your PC: `scp -i KEY -r ubuntu@IP:/opt/nexora/gateway/.data ./gateway-backup` |

Updates never touch `.env` or `.data`.

## Before judging

- **Free-model limits are shared by every judge:** 20 requests a minute and 1000 a day (the daily figure
  needs 10 credits bought on OpenRouter; otherwise it is 50). When a limit is reached the app says
  "busy, try again in a minute" and charges nothing. Settings → Gateway shows today's count.
- **Tell judges what they need:** a NEAR testnet wallet (MyNearWallet, Meteor, HERE or Intear) with
  testnet NEAR from a faucet, then deposit about 0.1 NEAR on the Dashboard. The first deposit keeps
  0.05 NEAR as a storage reserve, and a private session's note costs 0.02 NEAR. Without a wallet they can still use **Explore with a demo account**,
  which is fully simulated.
- **Back up `.data`** once in a while (table above). It is the only copy of the paid-notes list.
