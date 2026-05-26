(function () {
  "use strict";

  const DEFAULT_ADMIN_EMAIL = "getbrograde@gmail.com";

  function getEndpoint() {
    const metaEndpoint = document.querySelector('meta[name="brograde-scan-endpoint"]')?.content;
    return (window.BROGRADE_SCAN_ENDPOINT || metaEndpoint || "").trim();
  }

  function getAdminEmail() {
    return (window.BROGRADE_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim();
  }

  function appendPayload(formData, payload) {
    Object.entries(payload).forEach(([key, value]) => {
      formData.append(key, value == null ? "" : String(value));
    });
  }

  async function parseError(response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json().catch(() => null);
      return body?.message || body?.error || `Submission failed with status ${response.status}.`;
    }

    const text = await response.text().catch(() => "");
    return text || `Submission failed with status ${response.status}.`;
  }

  window.BroGradeScanSubmitter = {
    /**
     * Static-site submission adapter for the Free BroGrade Looks Scan.
     *
     * TODO when backend is ready:
     * 1. Set window.BROGRADE_SCAN_ENDPOINT to your serverless function, API route,
     *    form provider endpoint, or storage-backed submission endpoint.
     * 2. Store the record in a free_looks_scans table or collection with:
     *    id, created_at, first_name, age, email, height, weight, photo_type,
     *    main_goal, ideal_look, ideal_look_notes, photo_url or uploaded file
     *    reference, marketing_permission, consent_age_confirmed,
     *    consent_disclaimer_confirmed, and status.
     * 3. Use status values: new, reviewing, sent, upgraded, rejected.
     * 4. Store photos privately with unique filenames. Do not use public buckets
     *    unless signed URLs or privacy rules are configured.
     * 5. Send an admin notification to getbrograde@gmail.com or the configured
     *    admin email with name, age, email, goal, ideal look, photo type,
     *    submission timestamp, and the private photo link when available.
     */
    async submit({ payload, file }) {
      const endpoint = getEndpoint();
      const adminEmail = getAdminEmail();

      if (!endpoint) {
        throw new Error(
          `Free scan submission is not connected yet. Configure BROGRADE_SCAN_ENDPOINT before sending live scans. For now, email ${adminEmail} with the photo and scan details.`
        );
      }

      const formData = new FormData();
      appendPayload(formData, payload);
      formData.append("admin_email", adminEmail);
      formData.append("photo", file, file.name);

      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
        credentials: "omit"
      });

      if (!response.ok) {
        throw new Error(await parseError(response));
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return response.json();
      }

      return { ok: true };
    }
  };
})();
