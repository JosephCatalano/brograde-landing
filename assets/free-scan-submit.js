(function () {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/free-looks-scans";

  function getEndpoint() {
    const metaEndpoint = document.querySelector('meta[name="brograde-scan-endpoint"]')?.content;
    return (window.BROGRADE_SCAN_ENDPOINT || metaEndpoint || DEFAULT_ENDPOINT).trim();
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
     * Submission adapter for the Free BroGrade Looks Scan.
     * The Node server handles validation, private storage, AI generation, and email.
     */
    async submit({ payload, file }) {
      const endpoint = getEndpoint();

      const formData = new FormData();
      appendPayload(formData, payload);
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
