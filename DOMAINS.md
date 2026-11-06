# Store addresses (subdomains + custom domains) — setup

Merchants on Growth/Pro can claim `theirname.<your domain>`; Pro merchants can connect their own domain (`theirbrand.com`).
Everything is built. These steps switch it on. Until you do them, merchants can still reserve names; links keep using the normal storefront URL.

## 1. Buy one platform domain (once)
Any registrar. Example: `kooza.store`.

## 2. Point it at the storefront (Render)
1. Render dashboard -> the **bizflow-storefront** static site -> Settings -> **Custom Domains**.
2. Add `kooza.store`, and also the wildcard `*.kooza.store`. Render shows the DNS records to create.
3. At your registrar create exactly those records (usually a CNAME for `*` and `www`, and an A record for the bare domain).
4. Wait for Render to show both as Verified (certificates are issued automatically).

## 3. Tell the API about it (Render -> bizflow-api -> Environment)
| Variable | Value |
|---|---|
| `STORE_BASE_DOMAIN` | `kooza.store` (no https://, no www) |
| `STOREFRONT_URL` | `https://bizflow-storefront.onrender.com` (already used by emails) |
| `STOREFRONT_CNAME_TARGET` | optional, defaults to `bizflow-storefront.onrender.com` |
| `STOREFRONT_A_RECORD` | optional, defaults to Render's `216.24.57.1` — confirm in Render's docs |

## 4. Optional: attach merchants' own domains automatically
Without this, you add each merchant's domain by hand in Render (Custom Domains) after they connect it.
1. Render -> Account Settings -> **API Keys** -> create one.
2. Copy the storefront site's service id (starts with `srv-`) from its URL.
3. Add to the API environment: `RENDER_API_KEY` and `RENDER_STOREFRONT_SERVICE_ID`.
Then "Connect" adds the domain to Render, and "Check connection" asks Render to verify and issue the certificate.

## 5. Push
Push the files in the zips, let the API redeploy (schema.sql adds the new columns), then open Dashboard -> Storefront -> Store address.

Notes
- Plans: `subdomain` is on Growth and Pro, `custom_domain` on Pro (db/plans.js). If a merchant drops below the plan, their address stops resolving and links fall back to the plain storefront URL; nothing is deleted.
- Render limits how many custom domains a service can have by plan. Check yours before promoting this widely.
