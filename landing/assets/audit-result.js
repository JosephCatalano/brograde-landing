(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id") || "";
  const token = params.get("token") || "";
  const root = document.getElementById("audit-result-root");
  const statusBox = document.getElementById("audit-result-status");
  const printBtn = document.getElementById("audit-print");

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function scoreCard(label, item) {
    return `
      <article class="audit-score-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(item?.score ?? "Pending")}<small>/10</small></strong>
        <h3>${escapeHtml(item?.label || label)}</h3>
        <p>${escapeHtml(item?.rationale || "")}</p>
        <em>${escapeHtml(item?.first_fix || "")}</em>
      </article>
    `;
  }

  function insightList(items) {
    return (items || []).map((item, index) => `
      <article class="audit-insight">
        <span>${String(index + 1).padStart(2, "0")}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.why_it_matters || item.action)}</p>
        <strong>${escapeHtml(item.action || "")}</strong>
      </article>
    `).join("");
  }

  function shoppingRows(items) {
    return (items || []).map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.item)}</td>
        <td>${escapeHtml(item.color_fit)}</td>
        <td>${escapeHtml(item.budget)}</td>
        <td>${escapeHtml(item.why)}</td>
      </tr>
    `).join("");
  }

  function renderPending(data) {
    root.innerHTML = `
      <section class="audit-report-panel">
        <div class="eyebrow">Full Audit</div>
        <h1>Audit queued.</h1>
        <p class="lead">Your paid intake is saved. Expected delivery: ${escapeHtml(data.delivery_window || "24-48 hours")}.</p>
      </section>
    `;
  }

  function renderAudit(data) {
    const audit = data.full_audit;
    const scorecard = audit.scorecard;

    root.innerHTML = `
      <section class="audit-report-cover">
        <div>
          <div class="eyebrow">BroGrade Full Audit</div>
          <h1>Your upgrade plan is ready.</h1>
          <p>${escapeHtml(audit.executive_summary.summary)}</p>
        </div>
        <div class="audit-result-score">
          <span>Overall BroGrade</span>
          <strong>${escapeHtml(scorecard.overall_brograde.score)}<small>/10</small></strong>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>01</span>
          <h2>Executive Summary</h2>
        </div>
        <div class="audit-metrics">
          ${scoreCard("Current Baseline", audit.executive_summary.current_baseline)}
          ${scoreCard("Upgrade Potential", audit.executive_summary.upgrade_potential)}
        </div>
        <div class="audit-verdict">
          <h3>Verdict</h3>
          <p>${escapeHtml(audit.executive_summary.verdict)}</p>
          <dl>
            <div><dt>Primary Liability</dt><dd>${escapeHtml(audit.executive_summary.primary_liability)}</dd></div>
            <div><dt>Immediate ROI</dt><dd>${escapeHtml(audit.executive_summary.immediate_roi)}</dd></div>
          </dl>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>02</span>
          <h2>Scorecard</h2>
        </div>
        <div class="audit-score-grid">
          ${scoreCard("Style / Outfit Fit", scorecard.style_outfit_fit)}
          ${scoreCard("Hair Architecture", scorecard.hair_architecture)}
          ${scoreCard("Grooming Polish", scorecard.grooming_polish)}
          ${scoreCard("Physique / Proportion", scorecard.physique_proportion)}
          ${scoreCard("Digital Presence", scorecard.digital_presence)}
          ${scoreCard("Wardrobe Utility", scorecard.wardrobe_utility)}
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>03</span>
          <h2>Assets And Liabilities</h2>
        </div>
        <div class="audit-two-col">
          <div>${insightList(audit.visual_assets)}</div>
          <div>${insightList(audit.visual_liabilities)}</div>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>04</span>
          <h2>Style And Fit</h2>
        </div>
        <div class="audit-verdict">
          <dl>
            <div><dt>Current Read</dt><dd>${escapeHtml(audit.style_fit.current_read)}</dd></div>
            <div><dt>Target Read</dt><dd>${escapeHtml(audit.style_fit.target_read)}</dd></div>
            <div><dt>The Gap</dt><dd>${escapeHtml(audit.style_fit.gap)}</dd></div>
          </dl>
        </div>
        <div class="audit-two-col">
          <div>${insightList(audit.style_fit.directives)}</div>
          <div>${insightList(audit.style_fit.outfit_formulas)}</div>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>05</span>
          <h2>Hair And Grooming</h2>
        </div>
        <div class="audit-callout">
          <span>Barber Copy</span>
          <p>${escapeHtml(audit.hair_grooming.barber_instructions)}</p>
        </div>
        <p class="audit-copy"><strong>Recommended cut:</strong> ${escapeHtml(audit.hair_grooming.recommended_cut)}</p>
        <div class="audit-two-col">
          <div>${insightList(audit.hair_grooming.grooming_moves)}</div>
          <div>${insightList(audit.hair_grooming.baseline_skin_protocol)}</div>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>06</span>
          <h2>Physique And Photos</h2>
        </div>
        <div class="audit-two-col">
          <div>
            <p class="audit-copy"><strong>Visual baseline:</strong> ${escapeHtml(audit.physique_direction.visual_baseline)}</p>
            <p class="audit-copy"><strong>Highest ROI:</strong> ${escapeHtml(audit.physique_direction.highest_roi_opportunity)}</p>
            ${insightList(audit.physique_direction.training_priorities)}
          </div>
          <div>
            <p class="audit-copy"><strong>Photo read:</strong> ${escapeHtml(audit.photo_presence.current_read)}</p>
            ${insightList(audit.photo_presence.corrective_actions)}
          </div>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>07</span>
          <h2>Shopping Priorities</h2>
        </div>
        <div class="audit-table-wrap">
          <table class="audit-table">
            <thead><tr><th>#</th><th>Item</th><th>Color / Fit</th><th>Budget</th><th>Why</th></tr></thead>
            <tbody>${shoppingRows(audit.wardrobe.shopping_priorities)}</tbody>
          </table>
        </div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-section-head">
          <span>08</span>
          <h2>Execution Plan</h2>
        </div>
        <h3 class="audit-subhead">First Three Priorities</h3>
        <div class="audit-priority-grid">${insightList(audit.execution.first_three_priorities)}</div>
        <h3 class="audit-subhead">7-Day Sprint</h3>
        <div class="audit-priority-grid">${insightList(audit.execution.seven_day_plan)}</div>
        <h3 class="audit-subhead">30-Day Roadmap</h3>
        <div class="audit-priority-grid">${insightList(audit.execution.thirty_day_plan)}</div>
      </section>

      <section class="audit-report-panel">
        <div class="audit-callout">
          <span>Final Directive</span>
          <p>${escapeHtml(audit.final_directive)}</p>
        </div>
        <p class="audit-disclaimer">${escapeHtml(audit.disclaimer)}</p>
      </section>
    `;
  }

  async function loadAudit() {
    if (!id || !token) {
      statusBox.textContent = "Missing audit link.";
      return;
    }

    try {
      const response = await fetch(`/api/full-audits/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, { credentials: "omit" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || "Could not load audit.");
      const data = result.data || {};
      statusBox.textContent = data.full_audit ? "Private audit loaded." : "Audit queued.";
      if (data.full_audit) renderAudit(data);
      else renderPending(data);
    } catch (error) {
      statusBox.textContent = error.message || "Could not load audit.";
    }
  }

  printBtn?.addEventListener("click", () => window.print());
  loadAudit();
})();
