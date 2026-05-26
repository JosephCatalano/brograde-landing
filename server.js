require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");
const { Resend } = require("resend");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "landing");
const STORAGE_DIR = path.resolve(ROOT_DIR, process.env.BROGRADE_STORAGE_DIR || "storage");
const SCANS_DIR = path.join(STORAGE_DIR, "free-looks-scans");
const PORT = Number(process.env.PORT || 3000);
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const ADMIN_EMAIL = process.env.BROGRADE_ADMIN_EMAIL || "getbrograde@gmail.com";
const AI_REASONING_EFFORT = process.env.BROGRADE_AI_REASONING_EFFORT || "medium";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PHOTO_SIGNING_SECRET = process.env.SCAN_SIGNING_SECRET || crypto.randomBytes(32).toString("hex");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

const AI_MODEL = process.env.BROGRADE_AI_MODEL || "gpt-5.5";
const AI_FALLBACK_MODELS = parseCsv(process.env.BROGRADE_AI_FALLBACK_MODELS || "gpt-5.1,gpt-5");
const AI_MODELS = uniqueList([AI_MODEL, ...AI_FALLBACK_MODELS]);

if (!process.env.SCAN_SIGNING_SECRET) {
  console.warn("SCAN_SIGNING_SECRET is not set. Admin photo links will reset when the server restarts.");
}

fs.mkdirSync(SCANS_DIR, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many scan attempts. Try again later." }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PHOTO_SIZE,
    files: 1,
    fields: 32
  }
});

const photoTypes = new Set([
  "Full body / outfit",
  "Face / hair",
  "Dating profile photo",
  "Not sure"
]);

const mainGoals = new Set([
  "Style / outfits",
  "Hair / grooming",
  "Physique / gym",
  "Dating profile / photos",
  "Skin / face",
  "Overall appearance upgrade",
  "Not sure, I want the honest truth"
]);

const idealLooks = new Set([
  "Clean / mature",
  "Old money",
  "Athletic",
  "Mafia / sleek",
  "Business casual",
  "Streetwear",
  "Minimalist",
  "Luxury casual",
  "Gym / masculine",
  "Model-off-duty",
  "Not sure"
]);

const marketingOptions = new Set([
  "No",
  "Yes, with my face blurred",
  "Yes, but ask me first"
]);

function cleanString(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function toBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: ".png" };
  }

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: ".webp" };
  }

  return null;
}

function validateSubmission(body, file) {
  if (!file) throw fail("Photo is required.");
  if (file.size > MAX_PHOTO_SIZE) throw fail("Photo must be 10 MB or smaller.");

  const image = detectImage(file.buffer);
  if (!image) throw fail("Upload must be a valid jpg, jpeg, png, or webp image.");

  const firstName = cleanString(body.first_name, 80);
  const age = Number(body.age);
  const email = cleanString(body.email, 180).toLowerCase();
  const photoType = cleanString(body.photo_type, 80);
  const mainGoal = cleanString(body.main_goal, 120);
  const idealLook = cleanString(body.ideal_look, 120);
  const marketingPermission = cleanString(body.marketing_permission || "No", 80);

  if (!firstName) throw fail("First name is required.");
  if (!Number.isInteger(age) || age < 18 || age > 100) throw fail("You must be 18 or older to submit a BroGrade Looks Scan.");
  if (!isEmail(email)) throw fail("Enter a valid email address.");
  if (!photoTypes.has(photoType)) throw fail("Select a valid photo type.");
  if (!mainGoals.has(mainGoal)) throw fail("Select a valid main goal.");
  if (!idealLooks.has(idealLook)) throw fail("Select a valid ideal look.");
  if (!marketingOptions.has(marketingPermission)) throw fail("Select a valid marketing permission option.");
  if (!toBoolean(body.consent_age_confirmed)) throw fail("You must confirm you are 18 or older and uploading photos of yourself.");
  if (!toBoolean(body.consent_disclaimer_confirmed)) throw fail("You must confirm you understand the BroGrade feedback disclaimer.");

  return {
    first_name: firstName,
    age,
    email,
    height: cleanString(body.height, 80),
    weight: cleanString(body.weight, 80),
    photo_type: photoType,
    main_goal: mainGoal,
    ideal_look: idealLook,
    ideal_look_notes: cleanString(body.ideal_look_notes, 700),
    marketing_permission: marketingPermission,
    consent_age_confirmed: true,
    consent_disclaimer_confirmed: true,
    status: "new",
    image
  };
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

function getRecordPath(id) {
  return path.join(SCANS_DIR, id, "record.json");
}

async function readRecord(id) {
  const filePath = getRecordPath(id);
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

function signPhotoToken(id) {
  return crypto.createHmac("sha256", PHOTO_SIGNING_SECRET).update(`photo:${id}`).digest("hex");
}

function safeEquals(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getPhotoAdminUrl(record) {
  const token = signPhotoToken(record.id);
  return `${PUBLIC_BASE_URL}/api/admin/free-looks-scans/${record.id}/photo?token=${token}`;
}

function scanSchema() {
  const upgrade = {
    type: "object",
    additionalProperties: false,
    required: ["title", "why_it_matters", "first_step"],
    properties: {
      title: { type: "string" },
      why_it_matters: { type: "string" },
      first_step: { type: "string" }
    }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "overall_first_impression",
      "biggest_weak_point",
      "fastest_win",
      "top_3_upgrades",
      "category_notes",
      "quick_summary",
      "full_audit_teaser",
      "disclaimer"
    ],
    properties: {
      status: { type: "string", enum: ["completed", "needs_better_photo", "rejected"] },
      overall_first_impression: {
        type: "object",
        additionalProperties: false,
        required: ["score", "label", "rationale"],
        properties: {
          score: { type: "number" },
          label: { type: "string" },
          rationale: { type: "string" }
        }
      },
      biggest_weak_point: { type: "string" },
      fastest_win: { type: "string" },
      top_3_upgrades: {
        type: "array",
        items: upgrade
      },
      category_notes: {
        type: "object",
        additionalProperties: false,
        required: [
          "style_outfit_fit",
          "hair_grooming",
          "physique_direction",
          "photo_presence",
          "wardrobe_direction"
        ],
        properties: {
          style_outfit_fit: { type: "string" },
          hair_grooming: { type: "string" },
          physique_direction: { type: "string" },
          photo_presence: { type: "string" },
          wardrobe_direction: { type: "string" }
        }
      },
      quick_summary: { type: "string" },
      full_audit_teaser: { type: "string" },
      disclaimer: { type: "string" }
    }
  };
}

function buildPrompt(submission) {
  return [
    "Create a Free BroGrade Looks Scan from the uploaded image and the user's form answers.",
    "",
    "Brand voice: dark, direct, masculine, clean, premium, honest without being cruel. Use practical appearance language.",
    "Do not flatter. Do not shame. Do not use incel language, alpha language, medical claims, diagnosis, or guaranteed results.",
    "Review presentation only: clothing fit, silhouette, grooming, hair shape, photo presence, wardrobe direction, and general physique direction.",
    "Do not identify race, ethnicity, sexuality, class, exact weight, medical conditions, mental health, dermatology issues, or anything you cannot safely infer.",
    "If the image is too unclear, says little about the chosen goal, appears to include someone under 18, or contains someone other than the uploader, set status accordingly and explain the photo problem without a score above 5.",
    "Keep it useful for a cold traffic user. Give the first 3 changes, not a full paid audit.",
    "Make the feedback direct enough to feel valuable but clean enough to email to a normal customer.",
    "Use concrete visible signals. Avoid vague advice like be confident, glow up, or just dress better.",
    "If a category cannot be judged from the image, say limited read from this photo and still give the best useful next step.",
    "",
    "User context:",
    `First name: ${submission.first_name}`,
    `Age: ${submission.age}`,
    `Photo type: ${submission.photo_type}`,
    `Main goal: ${submission.main_goal}`,
    `Ideal look: ${submission.ideal_look}`,
    `Ideal look notes: ${submission.ideal_look_notes || "None"}`,
    `Height: ${submission.height || "Not provided"}`,
    `Weight: ${submission.weight || "Not provided"}`,
    "",
    "Scoring guidance: score the first impression of presentation, not human worth or genetic value. Use a realistic 1 to 10 score with one decimal.",
    "Output only structured JSON that matches the schema."
  ].join("\n");
}

function normalizeScan(scan) {
  const normalized = { ...scan };
  const impression = normalized.overall_first_impression || {};
  const score = Number(impression.score);
  normalized.overall_first_impression = {
    score: Number.isFinite(score) ? Math.max(1, Math.min(10, Math.round(score * 10) / 10)) : 5,
    label: cleanString(impression.label || "First scan", 80),
    rationale: cleanString(impression.rationale || "Initial presentation read based on the submitted photo.", 500)
  };

  normalized.status = ["completed", "needs_better_photo", "rejected"].includes(normalized.status) ? normalized.status : "completed";
  normalized.biggest_weak_point = cleanString(normalized.biggest_weak_point || "Photo clarity and presentation", 180);
  normalized.fastest_win = cleanString(normalized.fastest_win || "Retake the photo in clean lighting and use a more intentional outfit.", 180);
  normalized.quick_summary = cleanString(normalized.quick_summary || "This is a first-layer scan, not a full audit.", 700);
  normalized.full_audit_teaser = cleanString(normalized.full_audit_teaser || "The full audit gives the deeper breakdown across style, grooming, photos, wardrobe, and execution.", 500);
  normalized.disclaimer = cleanString(normalized.disclaimer || "BroGrade gives style, grooming, fitness-direction, and appearance feedback for self-improvement purposes only.", 500);

  const upgrades = Array.isArray(normalized.top_3_upgrades) ? normalized.top_3_upgrades : [];
  normalized.top_3_upgrades = upgrades.slice(0, 3).map((item, index) => ({
    title: cleanString(item?.title || `Upgrade ${index + 1}`, 120),
    why_it_matters: cleanString(item?.why_it_matters || "This affects the first read of the photo.", 400),
    first_step: cleanString(item?.first_step || "Make one small change and retake the photo.", 300)
  }));

  while (normalized.top_3_upgrades.length < 3) {
    normalized.top_3_upgrades.push({
      title: "Retake with intent",
      why_it_matters: "Bad lighting, weak angle, or random styling can hide what is actually working.",
      first_step: "Use clean light, eye-level camera height, and one intentional outfit."
    });
  }

  const notes = normalized.category_notes || {};
  normalized.category_notes = {
    style_outfit_fit: cleanString(notes.style_outfit_fit || "Limited read from this photo.", 500),
    hair_grooming: cleanString(notes.hair_grooming || "Limited read from this photo.", 500),
    physique_direction: cleanString(notes.physique_direction || "Limited read from this photo.", 500),
    photo_presence: cleanString(notes.photo_presence || "Limited read from this photo.", 500),
    wardrobe_direction: cleanString(notes.wardrobe_direction || "Limited read from this photo.", 500)
  };

  return normalized;
}

function getOpenAiRefusal(response) {
  for (const output of response.output || []) {
    for (const part of output.content || []) {
      if (part.type === "refusal" && part.refusal) return part.refusal;
    }
  }

  return "";
}

function shouldTryNextModel(error) {
  const status = Number(error.status || error.code || 0);
  if ([401, 403, 429].includes(status)) return false;

  const message = String(error.message || "");
  return /model|not found|does not exist|unsupported|not supported|invalid.*model|reasoning/i.test(message);
}

async function createScanWithModel(openai, model, submission, base64Image) {
  const response = await openai.responses.create({
    model,
    store: false,
    instructions: "You are BroGrade, an appearance presentation reviewer for men 18+. Be specific, direct, useful, and safety-aware. Output JSON only.",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt(submission) },
          { type: "input_image", image_url: `data:${submission.image.mimeType};base64,${base64Image}` }
        ]
      }
    ],
    reasoning: { effort: AI_REASONING_EFFORT },
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "brograde_looks_scan",
        description: "A first-layer BroGrade appearance scan result.",
        strict: true,
        schema: scanSchema()
      }
    },
    max_output_tokens: 1800
  });

  const refusal = getOpenAiRefusal(response);
  if (refusal) {
    throw new Error(`OpenAI refused the scan: ${refusal}`);
  }

  const outputText = response.output_text;
  if (!outputText) {
    throw new Error("OpenAI returned an empty scan.");
  }

  return {
    response,
    scan: normalizeScan(JSON.parse(outputText))
  };
}

async function generateAiScan(submission, file) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ai_status: "not_configured",
      model: null,
      scan: null,
      error: "OPENAI_API_KEY is not configured."
    };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const base64Image = file.buffer.toString("base64");
  const failures = [];

  for (const model of AI_MODELS) {
    try {
      const result = await createScanWithModel(openai, model, submission, base64Image);
      return {
        ai_status: "completed",
        model,
        attempted_models: AI_MODELS,
        response_id: result.response.id,
        scan: result.scan
      };
    } catch (error) {
      failures.push({ model, message: error.message });
      if (!shouldTryNextModel(error)) break;
    }
  }

  const summary = failures.map((item) => `${item.model}: ${item.message}`).join(" | ");
  throw new Error(`OpenAI scan failed after trying ${failures.length} model(s). ${summary}`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scanText(scan) {
  if (!scan) return "Your free scan was submitted and is queued for review.";

  return [
    `Overall First Impression: ${scan.overall_first_impression.score}/10`,
    `Biggest Weak Point: ${scan.biggest_weak_point}`,
    `Fastest Win: ${scan.fastest_win}`,
    "",
    "Top 3 upgrades:",
    ...scan.top_3_upgrades.map((item, index) => `${index + 1}. ${item.title}: ${item.first_step}`),
    "",
    scan.quick_summary,
    "",
    scan.disclaimer
  ].join("\n");
}

function scanHtml(scan) {
  if (!scan) {
    return "<p>Your free scan was submitted and is queued for review.</p>";
  }

  const upgrades = scan.top_3_upgrades.map((item, index) => `
    <li>
      <strong>${index + 1}. ${escapeHtml(item.title)}</strong><br/>
      ${escapeHtml(item.why_it_matters)}<br/>
      <em>${escapeHtml(item.first_step)}</em>
    </li>
  `).join("");

  return `
    <p><strong>Overall First Impression:</strong> ${escapeHtml(scan.overall_first_impression.score)}/10</p>
    <p><strong>Biggest Weak Point:</strong> ${escapeHtml(scan.biggest_weak_point)}</p>
    <p><strong>Fastest Win:</strong> ${escapeHtml(scan.fastest_win)}</p>
    <h3>Top 3 upgrades</h3>
    <ol>${upgrades}</ol>
    <p>${escapeHtml(scan.quick_summary)}</p>
    <p style="color:#666">${escapeHtml(scan.disclaimer)}</p>
  `;
}

async function sendEmail(resend, message) {
  const result = await resend.emails.send(message);
  if (result.error) {
    throw new Error(result.error.message || "Resend email failed.");
  }
  return result.data;
}

async function deliverEmails(record) {
  const results = {
    configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
    admin_sent: false,
    user_sent: false,
    error: null
  };

  if (!results.configured) {
    results.error = "RESEND_API_KEY and RESEND_FROM are required for email delivery.";
    return results;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const photoUrl = getPhotoAdminUrl(record);
  const submitted = new Date(record.created_at).toLocaleString("en-US", { timeZone: "America/Toronto" });
  const scan = record.scan;

  try {
    await sendEmail(resend, {
      from: process.env.RESEND_FROM,
      to: ADMIN_EMAIL,
      subject: `New BroGrade Looks Scan: ${record.first_name}`,
      text: [
        "New Free BroGrade Looks Scan",
        "",
        `Name: ${record.first_name}`,
        `Age: ${record.age}`,
        `Email: ${record.email}`,
        `Goal: ${record.main_goal}`,
        `Ideal look: ${record.ideal_look}`,
        `Photo type: ${record.photo_type}`,
        `Submitted: ${submitted}`,
        `Status: ${record.status}`,
        `AI status: ${record.ai_status}`,
        `Photo: ${photoUrl}`,
        "",
        scanText(scan)
      ].join("\n"),
      html: `
        <h2>New Free BroGrade Looks Scan</h2>
        <p><strong>Name:</strong> ${escapeHtml(record.first_name)}</p>
        <p><strong>Age:</strong> ${escapeHtml(record.age)}</p>
        <p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
        <p><strong>Goal:</strong> ${escapeHtml(record.main_goal)}</p>
        <p><strong>Ideal look:</strong> ${escapeHtml(record.ideal_look)}</p>
        <p><strong>Photo type:</strong> ${escapeHtml(record.photo_type)}</p>
        <p><strong>Submitted:</strong> ${escapeHtml(submitted)}</p>
        <p><strong>Status:</strong> ${escapeHtml(record.status)}</p>
        <p><strong>AI status:</strong> ${escapeHtml(record.ai_status)}</p>
        <p><a href="${escapeHtml(photoUrl)}">View private uploaded photo</a></p>
        <hr/>
        ${scanHtml(scan)}
      `
    });
    results.admin_sent = true;

    await sendEmail(resend, {
      from: process.env.RESEND_FROM,
      to: record.email,
      subject: scan ? "Your BroGrade Looks Scan is ready" : "Your BroGrade Looks Scan was submitted",
      text: [
        `Thanks for submitting your free BroGrade Looks Scan, ${record.first_name}.`,
        "",
        scanText(scan),
        "",
        "Want the full breakdown? The full BroGrade Beta Audit covers style, grooming, physique direction, photos, wardrobe, shopping priorities, and a 7-day upgrade plan.",
        "",
        "BroGrade gives style, grooming, fitness-direction, and appearance feedback for self-improvement purposes only. It is not medical, mental health, dermatology, or professional fitness advice."
      ].join("\n"),
      html: `
        <h2>Your BroGrade Looks Scan</h2>
        <p>Thanks for submitting your free BroGrade Looks Scan, ${escapeHtml(record.first_name)}.</p>
        ${scanHtml(scan)}
        <hr/>
        <p><strong>Want the full breakdown?</strong> The full BroGrade Beta Audit covers style, grooming, physique direction, photos, wardrobe, shopping priorities, and a 7-day upgrade plan.</p>
        <p style="color:#666">BroGrade gives style, grooming, fitness-direction, and appearance feedback for self-improvement purposes only. It is not medical, mental health, dermatology, or professional fitness advice.</p>
      `
    });
    results.user_sent = true;
  } catch (error) {
    results.error = error.message;
  }

  return results;
}

function publicRecord(record) {
  return {
    id: record.id,
    created_at: record.created_at,
    status: record.status,
    ai_status: record.ai_status,
    ai_model: record.ai_model,
    email_delivery: record.email_delivery,
    scan: record.scan || null
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ai_configured: Boolean(process.env.OPENAI_API_KEY),
    ai_model: AI_MODEL,
    ai_fallback_models: AI_FALLBACK_MODELS,
    ai_reasoning_effort: AI_REASONING_EFFORT,
    email_configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
    storage_configured: Boolean(STORAGE_DIR),
    storage_dir: STORAGE_DIR
  });
});

app.post("/api/free-looks-scans", apiLimiter, upload.single("photo"), async (req, res, next) => {
  try {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const submission = validateSubmission(req.body, req.file);
    const scanDir = path.join(SCANS_DIR, id);
    await fsp.mkdir(scanDir, { recursive: true });

    const photoPath = path.join(scanDir, `photo${submission.image.extension}`);
    await fsp.writeFile(photoPath, req.file.buffer);

    let aiResult;
    try {
      aiResult = await generateAiScan(submission, req.file);
    } catch (error) {
      console.error("AI scan failed:", error);
      aiResult = {
        ai_status: "failed",
        model: AI_MODEL,
        scan: null,
        error: error.message
      };
    }

    const record = {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      first_name: submission.first_name,
      age: submission.age,
      email: submission.email,
      height: submission.height,
      weight: submission.weight,
      photo_type: submission.photo_type,
      main_goal: submission.main_goal,
      ideal_look: submission.ideal_look,
      ideal_look_notes: submission.ideal_look_notes,
      photo_file_name: req.file.originalname,
      photo_mime_type: submission.image.mimeType,
      photo_size: req.file.size,
      photo_path: photoPath,
      marketing_permission: submission.marketing_permission,
      consent_age_confirmed: submission.consent_age_confirmed,
      consent_disclaimer_confirmed: submission.consent_disclaimer_confirmed,
      status: aiResult.scan ? "reviewing" : "new",
      ai_status: aiResult.ai_status,
      ai_model: aiResult.model,
      ai_attempted_models: aiResult.attempted_models || AI_MODELS,
      ai_response_id: aiResult.response_id || null,
      ai_error: aiResult.error || null,
      scan: aiResult.scan,
      email_delivery: null
    };

    await writeJsonAtomic(getRecordPath(id), record);

    const emailDelivery = await deliverEmails(record);
    record.email_delivery = emailDelivery;
    record.updated_at = new Date().toISOString();
    if (record.scan) {
      record.status = "sent";
    }

    await writeJsonAtomic(getRecordPath(id), record);

    res.status(201).json({
      ok: true,
      message: record.scan ? "Your BroGrade Looks Scan is ready." : "Your BroGrade Looks Scan was submitted.",
      data: publicRecord(record)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/free-looks-scans/:id/photo", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail("Invalid scan id.", 400);
    if (!safeEquals(req.query.token, signPhotoToken(id))) throw fail("Invalid photo token.", 403);

    const record = await readRecord(id);
    res.type(record.photo_mime_type);
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(record.photo_path);
  } catch (error) {
    next(error);
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/scan", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "scan.html"));
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "public, max-age=300");
  }
}));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ ok: false, message: "API route not found." });
    return;
  }

  res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Photo must be 10 MB or smaller." : "Invalid upload.";
    res.status(400).json({ ok: false, message });
    return;
  }

  const status = error.status || 500;
  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    ok: false,
    message: status >= 500 ? "Something went wrong while submitting your scan." : error.message
  });
});

app.listen(PORT, () => {
  console.log(`BroGrade running at http://localhost:${PORT}`);
  console.log(`Free scan endpoint: http://localhost:${PORT}/api/free-looks-scans`);
});
