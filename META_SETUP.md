# Meta integration — WhatsApp Business, Facebook Messenger, Instagram DMs

The code is finished and tested against simulated Meta responses. Switching it on needs a Meta app that only you can create.
Meta's dashboard changes often, so treat the menu names below as a guide and check them against developers.facebook.com/docs.

## 1. Create the app
1. developers.facebook.com -> **My Apps -> Create App** -> type **Business**. Link it to your Meta Business portfolio.
2. Add products: **WhatsApp**, **Messenger**, **Instagram** (Messenger API for Instagram / API with Facebook Login) and **Facebook Login for Business**.

## 2. Render environment variables (bizflow-api)
| Variable | Where it comes from |
|---|---|
| `META_APP_ID` | App settings -> Basic |
| `META_APP_SECRET` | App settings -> Basic (Show) |
| `META_VERIFY_TOKEN` | Any long random string you invent (used in step 3) |
| `META_WA_CONFIG_ID` | Step 4 |
| `META_TOKEN_KEY` | Any long random string. Encrypts stored access tokens. Set it once and never change it |
| `META_GRAPH_VERSION` | Optional, defaults to `v23.0` |

## 3. Webhooks (App dashboard -> each product's Webhooks / Configuration)
- **Callback URL:** `https://bizflow-api-v0sd.onrender.com/api/meta-webhook`
- **Verify token:** the same value as `META_VERIFY_TOKEN`
- Subscribe to: WhatsApp Business Account -> `messages`; Page -> `messages`, `messaging_postbacks`; Instagram -> `messages`.
Every call is checked against `META_APP_SECRET` (X-Hub-Signature-256); anything unsigned is rejected.

## 4. WhatsApp "Embedded Signup" (lets a merchant connect their own number inside Kooza)
1. Facebook Login for Business -> **Configurations -> Create** -> template **WhatsApp Embedded Signup**.
2. Permissions: `whatsapp_business_management`, `whatsapp_business_messaging`.
3. Copy the **Configuration ID** into `META_WA_CONFIG_ID`.

## 5. Login settings
- Facebook Login -> Settings: turn on **Login with the JavaScript SDK** and add your dashboard domain (`bizflow-dashboard.onrender.com`) to **Allowed Domains for the JavaScript SDK**.
- App settings -> Basic: add your **Privacy Policy URL**, and
  - **Data deletion callback URL:** `https://bizflow-api-v0sd.onrender.com/api/meta-webhook/data-deletion`
  - **Deauthorize callback URL:** `https://bizflow-api-v0sd.onrender.com/api/meta-webhook/deauthorize`

## 6. Test before going public
While the app is in **Development mode**, people with a role on the app (you, testers) can connect and message. Use that to test every flow:
- WhatsApp: connect a spare number (or Meta's free test number), message it from your phone, reply from Inbox.
- Messenger / Instagram: connect a test Facebook page, message it from another account.

## 7. Going live for all merchants
Needs Meta approval (this takes days to weeks; plan for it):
1. **Business verification** of your company.
2. **App Review** with Advanced Access for: `pages_messaging`, `pages_show_list`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_messages`, `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`. Reviewers want a screen recording of the connect flow and a reply from the inbox.
3. For WhatsApp Embedded Signup you must also be a **Tech Provider** (app-level onboarding in the WhatsApp product settings).
Then switch the app to **Live**.

## What the merchant sees
Inbox -> **Channels** (or the sidebar WhatsApp item): Connect WhatsApp / Facebook / Instagram. Messages appear in the shared inbox with a channel icon; replies go out through Meta.
Merchants need the Growth plan or above (the inbox feature).

## Meta's rules the app follows
- You can reply freely only **within 24 hours** of the customer's last message. After that the composer explains this and waits for the customer to write again.
- Photos/voice notes/documents arrive as placeholders like `[Photo] caption` (media download is the next step).
- Instagram needs a professional (business/creator) account linked to a Facebook page.
- Not built yet: WhatsApp **message templates** (needed to start a conversation or send broadcasts outside the 24-hour window) and sending images.
