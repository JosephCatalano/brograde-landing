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
