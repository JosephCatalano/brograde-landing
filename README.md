# BroGrade

Full-stack BroGrade landing page and Free Looks Scan flow.

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
http://localhost:3000/scan.html
http://localhost:3000/audit.html
http://localhost:3000/api/health
```

## Required Railway Variables

```env
PUBLIC_BASE_URL=https://www.brograde.com
OPENAI_API_KEY=your_openai_key
BROGRADE_AI_MODEL=gpt-5.5
BROGRADE_AI_FALLBACK_MODELS=gpt-5.1,gpt-5
BROGRADE_AI_REASONING_EFFORT=medium
SCAN_SIGNING_SECRET=make-this-a-long-random-secret
BROGRADE_STORAGE_DIR=/data
```

## Optional Stripe Variables

```env
STRIPE_SECRET_KEY=sk_test_or_live_key
BROGRADE_AUDIT_PRICE_CENTS=1900
BROGRADE_AUDIT_CURRENCY=usd
BROGRADE_AUDIT_DELIVERY_WINDOW=24-48 hours
BROGRADE_AUDIT_REVISION_POLICY=One actionability revision included during beta.
```

For local end-to-end testing without Stripe payment, add this to `.env` and restart:

```env
BROGRADE_DEV_CHECKOUT_BYPASS=true
```

This exposes a local-only "Test Without Payment" button on the audit page. It is ignored when `NODE_ENV=production`.

## Optional Email Variables

```env
RESEND_API_KEY=your_resend_key
RESEND_FROM="BroGrade <scan@yourdomain.com>"
BROGRADE_ADMIN_EMAIL=getbrograde@gmail.com
```

## Railway Storage

Add a Railway volume mounted at:

```text
/data
```

The app stores private uploads and scan records under `BROGRADE_STORAGE_DIR`.

## Check AI

After adding `OPENAI_API_KEY`, run:

```bash
npm run ai:check
```

The app uses `BROGRADE_AI_MODEL` first and then tries `BROGRADE_AI_FALLBACK_MODELS` if the primary model is not enabled for the account.

On Railway, you can also check the deployed app with:

```bash
curl -H "x-brograde-admin-secret: YOUR_SCAN_SIGNING_SECRET" https://www.brograde.com/api/admin/ai-check
```

If this fails, the scan form will save submissions but will not show an AI result.

## Health Check

```text
/api/health
```

Expected production result:

```json
{
  "ok": true,
  "ai_configured": true,
  "email_configured": true
}
```
