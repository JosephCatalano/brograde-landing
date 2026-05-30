(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id") || "";
  const scanId = params.get("scan_id") || "";
  const form = document.getElementById("full-audit-form");
  const errorBox = document.getElementById("full-audit-error");
  const statusBox = document.getElementById("full-audit-status");
  const submitBtn = document.getElementById("full-audit-submit");
  const gate = document.getElementById("audit-intake-gate");
  const sessionBadge = document.getElementById("audit-session-badge");
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp"];
  const maxFileSize = 10 * 1024 * 1024;
  let paymentReady = false;

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

  function getPhotoError(file) {
    if (!file) return "";
    const lowerName = file.name.toLowerCase();
    const extensionOk = allowedExtensions.some((ext) => lowerName.endsWith(ext));
    if (!allowedTypes.includes(file.type) && !extensionOk) return "Photos must be jpg, jpeg, png, or webp images.";
    if (file.size > maxFileSize) return "Each photo must be 10 MB or smaller.";
    return "";
  }

  function validateForm() {
    if (!paymentReady) return "Payment is not verified yet.";

    const requiredPhotoIds = ["front_photo", "side_photo", "face_photo", "best_outfit_photo"];
    for (const id of requiredPhotoIds) {
      const input = document.getElementById(id);
      if (!input?.files?.[0]) return "Upload all required photos before submitting.";
    }

    for (const input of form.querySelectorAll('input[type="file"]')) {
      const error = getPhotoError(input.files[0]);
      if (error) return error;
    }

    const age = Number(form.age.value);
    if (!form.first_name.value.trim()) return "First name is required.";
    if (!age || age < 18) return "You must be 18 or older to submit a full audit.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.value.trim())) return "Enter a valid email address.";
    if (!form.main_goal.value.trim()) return "Main goal is required.";
    if (!form.target_look.value.trim()) return "Target look is required.";
    if (!form.querySelector('input[name="focus_areas"]:checked')) return "Select at least one focus area.";
    if (!form.current_style.value.trim()) return "Current style context is required.";
    if (!form.biggest_frustration.value.trim()) return "Biggest frustration is required.";
    if (!form.desired_outcome.value.trim()) return "Desired outcome is required.";
    if (!form.consent_age_confirmed.checked) return "Confirm you are 18 or older and uploading yourself.";
    if (!form.consent_disclaimer_confirmed.checked) return "Confirm the BroGrade feedback disclaimer.";
    return "";
  }

  function setFileSummary(input) {
    const summary = document.querySelector(`[data-file-summary="${input.id}"]`);
    if (!summary) return;
    const file = input.files[0];
    if (!file) {
      summary.textContent = "No file selected";
      return;
    }
    summary.textContent = `${file.name} - ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  }

  async function verifySession() {
    if (!sessionId) {
      gate?.classList.add("show");
      showError("Start with checkout before completing the full audit intake.");
      return;
    }

    showStatus("Verifying payment...");

    try {
      const response = await fetch(`/api/audit-checkout-session/${encodeURIComponent(sessionId)}`, { credentials: "omit" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || "Payment could not be verified.");

      const data = result.data || {};
      paymentReady = true;
      document.getElementById("checkout_session_id").value = sessionId;
      document.getElementById("scan_id").value = scanId || data.scan_id || "";
      if (data.customer_email && !form.email.value) form.email.value = data.customer_email;
      if (data.customer_name && !form.first_name.value) form.first_name.value = data.customer_name.split(" ")[0];
      if (sessionBadge) sessionBadge.textContent = "Payment verified";
      showStatus("Payment verified. Complete your audit intake below.");
      submitBtn.disabled = false;
    } catch (error) {
      gate?.classList.add("show");
      showError(error.message || "Payment could not be verified.");
    }
  }

  async function submitAudit(event) {
    event.preventDefault();
    const error = validateForm();
    if (error) {
      showError(error);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Building audit...";
    showStatus("Submitting photos and building your audit. This can take a minute.");

    try {
      const formData = new FormData(form);
      const response = await fetch("/api/full-audits", {
        method: "POST",
        body: formData,
        credentials: "omit"
      });

      const result = await response.json().catch(() => null);
      if (response.status === 409 && result?.data?.result_url) {
        window.location.href = result.data.result_url.replace("audit-result.html", "audit-success.html");
        return;
      }

      if (!response.ok) throw new Error(result?.message || "Could not submit full audit.");

      const resultUrl = result?.data?.result_url;
      if (resultUrl) {
        window.location.href = resultUrl.replace("audit-result.html", "audit-success.html");
        return;
      }

      window.location.href = "audit-success.html";
    } catch (error) {
      showError(error.message || "Could not submit full audit.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Full Audit";
    }
  }

  form?.querySelectorAll('input[type="file"]').forEach((input) => {
    input.addEventListener("change", () => {
      const error = getPhotoError(input.files[0]);
      if (error) {
        showError(error);
        input.value = "";
      }
      setFileSummary(input);
    });
  });

  submitBtn.disabled = true;
  form?.addEventListener("submit", submitAudit);
  verifySession();
})();
