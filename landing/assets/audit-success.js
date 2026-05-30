(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id") || "";
  const token = params.get("token") || "";
  const statusBox = document.getElementById("audit-success-status");
  const resultLink = document.getElementById("audit-result-link");
  const summary = document.getElementById("audit-success-summary");

  function setStatus(message) {
    if (statusBox) statusBox.textContent = message;
  }

  async function loadAudit() {
    if (!id || !token) {
      setStatus("Your audit was submitted. Check your email for the private result link.");
      return;
    }

    const href = `audit-result.html?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    if (resultLink) {
      resultLink.href = href;
      resultLink.hidden = false;
    }

    try {
      const response = await fetch(`/api/full-audits/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, { credentials: "omit" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || "Audit status could not be loaded.");

      const data = result.data || {};
      if (data.full_audit) {
        setStatus("Your full audit is ready.");
        if (summary) {
          summary.textContent = `${data.full_audit.executive_summary.primary_liability} First move: ${data.full_audit.executive_summary.immediate_roi}`;
        }
        return;
      }

      setStatus(`Your audit is submitted. Expected delivery: ${data.delivery_window || "24-48 hours"}.`);
    } catch (error) {
      setStatus(error.message || "Audit status could not be loaded.");
    }
  }

  loadAudit();
})();
