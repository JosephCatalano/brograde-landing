(function () {
  "use strict";

  const form = document.getElementById("audit-checkout-form");
  const errorBox = document.getElementById("audit-checkout-error");
  const statusBox = document.getElementById("audit-checkout-status");
  const submitBtn = document.getElementById("audit-checkout-submit");
  const devSubmitBtn = document.getElementById("audit-dev-checkout-submit");
  const params = new URLSearchParams(window.location.search);

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = value;
    });
  }

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.classList.add("show");
    statusBox?.classList.remove("show");
  }

  function showStatus(message) {
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.classList.add("show");
    errorBox?.classList.remove("show");
  }

  async function loadConfig() {
    try {
      const response = await fetch("/api/full-audit-config", { credentials: "omit" });
      if (!response.ok) return;

      const result = await response.json();
      const config = result.data || {};
      if (config.price_label) setText("[data-audit-price]", config.price_label);
      if (config.delivery_window) setText("[data-audit-delivery]", config.delivery_window);
      if (config.revision_policy) setText("[data-audit-revision]", config.revision_policy);

      if (!config.stripe_configured) {
        showError("Checkout is not configured yet. Add STRIPE_SECRET_KEY before taking paid audits.");
      }

      if (config.dev_checkout_bypass && devSubmitBtn) {
        devSubmitBtn.hidden = false;
        if (!config.stripe_configured) {
          showStatus("Local test mode is enabled. Use Test Without Payment to complete the audit flow.");
        }
      }
    } catch (error) {
      // The checkout route will surface the real error if config cannot load.
    }
  }

  async function startCheckout(event) {
    event.preventDefault();
    await beginCheckout("/api/audit-checkout-session", submitBtn, "Opening checkout...");
  }

  async function startDevCheckout() {
    await beginCheckout("/api/dev-audit-checkout-session", devSubmitBtn, "Opening test intake...");
  }

  async function beginCheckout(endpoint, button, loadingText) {
    if (!form || !submitBtn) return;

    const formData = new FormData(form);
    const payload = {
      first_name: String(formData.get("first_name") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      scan_id: params.get("scan_id") || ""
    };

    submitBtn.disabled = true;
    if (devSubmitBtn) devSubmitBtn.disabled = true;
    if (button) button.textContent = loadingText;
    showStatus(endpoint.includes("dev") ? "Creating local test checkout..." : "Opening secure checkout...");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit"
      });

      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(result?.message || "Could not start checkout.");
      }

      if (!result?.data?.url) throw new Error("Checkout did not return a redirect URL.");
      window.location.href = result.data.url;
    } catch (error) {
      showError(error.message || "Could not start checkout.");
      submitBtn.disabled = false;
      if (devSubmitBtn) devSubmitBtn.disabled = false;
      submitBtn.textContent = "Start Full Audit - $19";
      if (devSubmitBtn) devSubmitBtn.textContent = "Test Without Payment";
    }
  }

  if (params.get("checkout") === "cancelled") {
    showError("Checkout was cancelled. You can restart whenever you are ready.");
  }

  form?.addEventListener("submit", startCheckout);
  devSubmitBtn?.addEventListener("click", startDevCheckout);
  loadConfig();
})();
