# Deploy Nexus to a DigitalOcean Droplet

**What you need to do (≈5 minutes, no technical steps):**

## 1. Create the droplet
1. Go to https://cloud.digitalocean.com → log in
2. Left sidebar → **Droplets** → blue **Create Droplet** button
3. **Choose an image:** Ubuntu → **Ubuntu 24.04 (LTS) x64**
4. **Choose a plan:** Basic → Regular → **$12/mo** (2 GB / 1 vCPU — gives Postgres + Node headroom)
5. **Choose a region:** Toronto (tor1) or New York (nyc3) — closest to WI
6. **Authentication:** click **SSH Key** → **New SSH Key**
   - Paste this EXACT value into the box (it's my deploy key — one line, starts with `ssh-ed25519`):
     ```
     ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJBdEmaLlgmF1jdzaK71ePBs+G7KlhzlXISahfms39x nexus-droplet-deploy
     ```
   - Click **Add SSH Key**
7. **Number of Droplets:** 1
8. Choose a hostname if you want (e.g. `nexus`), then click **Create Droplet**
9. Wait ~30–60 seconds for it to boot

## 2. Give me the IP
1. In the droplet list, the new droplet shows an IPv4 address (e.g. `146.190.1.23`)
2. **Paste that IP into this chat**

That's it — I'll SSH in with the key and run the provisioning (Node 20, PostgreSQL, nginx, app clone, frontend build, schema, systemd service, reverse proxy). You'll get back the working URL.

## 3. What happens after provisioning
- App served at `http://<droplet-ip>/` in **production mode, sandbox orders** (`NICEHASH_LIVE_ORDERS=0` — nothing real can be spent until you flip it)
- Verify: open the IP in a browser → dashboard loads; I'll also run the upgrade endpoint test
- Optional later: point a domain (e.g. `nexus.donelocal.io`) at the IP for HTTPS via certbot

## 4. When you're ready for real orders (later, separate step)
Fill in `NICEHASH_API_KEY` / `NICEHASH_API_SECRET` / `NICEHASH_ORG_ID` / `NICEHASH_POOL_ID` in `/opt/nexus-mining-platform/backend/.env` on the server, then set `NICEHASH_LIVE_ORDERS=1` and restart. I'll walk you through it when we get there.

---

## Notes
- The old hauliq droplet (138.68.239.233) is unreachable and was flagged with exposed keys — **do not reuse it**; we start clean.
- Deployment targets branch `feature/nicehash-live-loop` (the new upgrade loop). Once you've tested and merged to `main`, I'll switch the server to track `main`.
