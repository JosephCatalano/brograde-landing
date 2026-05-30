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
const Stripe = require("stripe");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "landing");
const STORAGE_DIR = path.resolve(ROOT_DIR, process.env.BROGRADE_STORAGE_DIR || "storage");
const SCANS_DIR = path.join(STORAGE_DIR, "free-looks-scans");
const FULL_AUDITS_DIR = path.join(STORAGE_DIR, "full-audits");
const PORT = Number(process.env.PORT || 3000);
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const ADMIN_EMAIL = process.env.BROGRADE_ADMIN_EMAIL || "getbrograde@gmail.com";
const AI_REASONING_EFFORT = process.env.BROGRADE_AI_REASONING_EFFORT || "medium";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PHOTO_SIGNING_SECRET = process.env.SCAN_SIGNING_SECRET || crypto.randomBytes(32).toString("hex");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const AUDIT_PRICE_CENTS = Math.max(100, Number(process.env.BROGRADE_AUDIT_PRICE_CENTS || 1900));
const AUDIT_CURRENCY = cleanString(process.env.BROGRADE_AUDIT_CURRENCY || "usd", 12).toLowerCase();
const AUDIT_DELIVERY_WINDOW = cleanString(process.env.BROGRADE_AUDIT_DELIVERY_WINDOW || "24-48 hours", 80);
const AUDIT_REVISION_POLICY = cleanString(process.env.BROGRADE_AUDIT_REVISION_POLICY || "One actionability revision included during beta.", 160);
const DEV_CHECKOUT_BYPASS = toBoolean(process.env.BROGRADE_DEV_CHECKOUT_BYPASS) && process.env.NODE_ENV !== "production";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const devCheckoutSessions = new Map();

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
fs.mkdirSync(FULL_AUDITS_DIR, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "64kb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many attempts. Try again later." }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PHOTO_SIZE,
    files: 1,
    fields: 32
  }
});

const auditUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PHOTO_SIZE,
    files: 8,
    fields: 80
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

const auditBudgets = new Set([
  "Under $150",
  "$150-$300",
  "$300-$600",
  "$600-$1,000",
  "$1,000+",
  "No set budget"
]);

const auditEnvironments = new Set([
  "Dating",
  "School / campus",
  "Professional / office",
  "Social / nightlife",
  "Gym / fitness",
  "Everyday casual",
  "Personal brand / content",
  "Other"
]);

const auditFocusAreas = new Set([
  "Style / outfits",
  "Hair / grooming",
  "Physique / gym",
  "Dating profile / photos",
  "Wardrobe shopping",
  "Overall appearance upgrade"
]);

const auditPhotoFields = [
  { name: "front_photo", label: "Full body front", required: true },
  { name: "side_photo", label: "Side profile", required: true },
  { name: "face_photo", label: "Face and hair", required: true },
  { name: "best_outfit_photo", label: "Best current outfit", required: true },
  { name: "worst_outfit_photo", label: "Weakest current outfit", required: false },
  { name: "dating_profile_photo", label: "Dating/profile photo", required: false },
  { name: "closet_photo", label: "Closet or wardrobe", required: false },
  { name: "extra_photo", label: "Extra context photo", required: false }
];

const auditPhotoUploadFields = auditPhotoFields.map((field) => ({
  name: field.name,
  maxCount: 1
}));

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

function collectAuditFocusAreas(value) {
  const selected = Array.isArray(value) ? value : String(value || "").split(",");
  return uniqueList(selected.map((item) => cleanString(item, 80))).filter((item) => auditFocusAreas.has(item));
}

function validateAuditPhotos(files) {
  const photoMap = files || {};
  const photos = [];

  for (const field of auditPhotoFields) {
    const file = photoMap[field.name]?.[0];
    if (!file) {
      if (field.required) throw fail(`${field.label} photo is required.`);
      continue;
    }

    if (file.size > MAX_PHOTO_SIZE) throw fail(`${field.label} photo must be 10 MB or smaller.`);

    const image = detectImage(file.buffer);
    if (!image) throw fail(`${field.label} must be a valid jpg, jpeg, png, or webp image.`);

    photos.push({
      key: field.name,
      label: field.label,
      file,
      image
    });
  }

  return photos;
}

function validateAuditSubmission(body, files) {
  const firstName = cleanString(body.first_name, 80);
  const age = Number(body.age);
  const email = cleanString(body.email, 180).toLowerCase();
  const checkoutSessionId = cleanString(body.checkout_session_id, 220);
  const scanId = cleanString(body.scan_id, 80);
  const mainGoal = cleanString(body.main_goal, 120);
  const targetLook = cleanString(body.target_look, 120);
  const budget = cleanString(body.budget, 80);
  const primaryEnvironment = cleanString(body.primary_environment, 120);
  const currentStyle = cleanString(body.current_style, 700);
  const biggestFrustration = cleanString(body.biggest_frustration, 700);
  const desiredOutcome = cleanString(body.desired_outcome, 700);
  const focusAreas = collectAuditFocusAreas(body.focus_areas);
  const marketingPermission = cleanString(body.marketing_permission || "No", 80);
  const photos = validateAuditPhotos(files);

  if (!firstName) throw fail("First name is required.");
  if (!Number.isInteger(age) || age < 18 || age > 100) throw fail("You must be 18 or older to submit a BroGrade Full Audit.");
  if (!isEmail(email)) throw fail("Enter a valid email address.");
  if (!checkoutSessionId) throw fail("Paid checkout session is required.");
  if (scanId && !/^[0-9a-f-]{36}$/i.test(scanId)) throw fail("Invalid free scan id.");
  if (!mainGoal) throw fail("Main goal is required.");
  if (!targetLook) throw fail("Target look is required.");
  if (!auditBudgets.has(budget)) throw fail("Select a valid wardrobe budget.");
  if (!auditEnvironments.has(primaryEnvironment)) throw fail("Select a valid primary environment.");
  if (focusAreas.length === 0) throw fail("Select at least one audit focus area.");
  if (!currentStyle) throw fail("Current style context is required.");
  if (!biggestFrustration) throw fail("Biggest frustration is required.");
  if (!desiredOutcome) throw fail("Desired outcome is required.");
  if (!marketingOptions.has(marketingPermission)) throw fail("Select a valid marketing permission option.");
  if (!toBoolean(body.consent_age_confirmed)) throw fail("You must confirm you are 18 or older and uploading photos of yourself.");
  if (!toBoolean(body.consent_disclaimer_confirmed)) throw fail("You must confirm you understand the BroGrade feedback disclaimer.");

  return {
    first_name: firstName,
    age,
    email,
    checkout_session_id: checkoutSessionId,
    scan_id: scanId,
    main_goal: mainGoal,
    target_look: targetLook,
    focus_areas: focusAreas,
    budget,
    primary_environment: primaryEnvironment,
    current_style: currentStyle,
    biggest_frustration: biggestFrustration,
    desired_outcome: desiredOutcome,
    brands_liked: cleanString(body.brands_liked, 500),
    brands_avoided: cleanString(body.brands_avoided, 500),
    haircut_context: cleanString(body.haircut_context, 500),
    gym_context: cleanString(body.gym_context, 500),
    dating_context: cleanString(body.dating_context, 500),
    city_climate: cleanString(body.city_climate, 240),
    height: cleanString(body.height, 80),
    weight: cleanString(body.weight, 80),
    marketing_permission: marketingPermission,
    consent_age_confirmed: true,
    consent_disclaimer_confirmed: true,
    photos
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

function getAuditRecordPath(id) {
  return path.join(FULL_AUDITS_DIR, id, "record.json");
}

async function readAuditRecord(id) {
  const filePath = getAuditRecordPath(id);
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

function signPhotoToken(id) {
  return crypto.createHmac("sha256", PHOTO_SIGNING_SECRET).update(`photo:${id}`).digest("hex");
}

function signAuditPhotoToken(id, photoKey) {
  return crypto.createHmac("sha256", PHOTO_SIGNING_SECRET).update(`audit-photo:${id}:${photoKey}`).digest("hex");
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

function getAuditPhotoAdminUrl(record, photo) {
  const token = signAuditPhotoToken(record.id, photo.key);
  return `${PUBLIC_BASE_URL}/api/admin/full-audits/${record.id}/photo/${photo.key}?token=${token}`;
}

function getAuditResultUrl(record) {
  return `${PUBLIC_BASE_URL}/audit-result.html?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(record.result_token)}`;
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

function fullAuditSchema() {
  const scoreItem = {
    type: "object",
    additionalProperties: false,
    required: ["score", "label", "rationale", "first_fix"],
    properties: {
      score: { type: "number" },
      label: { type: "string" },
      rationale: { type: "string" },
      first_fix: { type: "string" }
    }
  };

  const namedInsight = {
    type: "object",
    additionalProperties: false,
    required: ["title", "why_it_matters", "action"],
    properties: {
      title: { type: "string" },
      why_it_matters: { type: "string" },
      action: { type: "string" }
    }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "executive_summary",
      "scorecard",
      "visual_assets",
      "visual_liabilities",
      "style_fit",
      "hair_grooming",
      "physique_direction",
      "photo_presence",
      "wardrobe",
      "execution",
      "final_directive",
      "disclaimer"
    ],
    properties: {
      status: { type: "string", enum: ["completed", "needs_manual_review", "needs_better_photos"] },
      executive_summary: {
        type: "object",
        additionalProperties: false,
        required: ["current_baseline", "upgrade_potential", "primary_liability", "immediate_roi", "verdict", "summary"],
        properties: {
          current_baseline: scoreItem,
          upgrade_potential: scoreItem,
          primary_liability: { type: "string" },
          immediate_roi: { type: "string" },
          verdict: { type: "string" },
          summary: { type: "string" }
        }
      },
      scorecard: {
        type: "object",
        additionalProperties: false,
        required: [
          "style_outfit_fit",
          "hair_architecture",
          "grooming_polish",
          "physique_proportion",
          "digital_presence",
          "wardrobe_utility",
          "overall_brograde"
        ],
        properties: {
          style_outfit_fit: scoreItem,
          hair_architecture: scoreItem,
          grooming_polish: scoreItem,
          physique_proportion: scoreItem,
          digital_presence: scoreItem,
          wardrobe_utility: scoreItem,
          overall_brograde: scoreItem
        }
      },
      visual_assets: { type: "array", items: namedInsight },
      visual_liabilities: { type: "array", items: namedInsight },
      style_fit: {
        type: "object",
        additionalProperties: false,
        required: ["current_read", "target_read", "gap", "directives", "outfit_formulas"],
        properties: {
          current_read: { type: "string" },
          target_read: { type: "string" },
          gap: { type: "string" },
          directives: { type: "array", items: namedInsight },
          outfit_formulas: { type: "array", items: namedInsight }
        }
      },
      hair_grooming: {
        type: "object",
        additionalProperties: false,
        required: ["recommended_cut", "barber_instructions", "grooming_moves", "baseline_skin_protocol"],
        properties: {
          recommended_cut: { type: "string" },
          barber_instructions: { type: "string" },
          grooming_moves: { type: "array", items: namedInsight },
          baseline_skin_protocol: { type: "array", items: namedInsight }
        }
      },
      physique_direction: {
        type: "object",
        additionalProperties: false,
        required: ["visual_baseline", "highest_roi_opportunity", "training_priorities", "posture_note"],
        properties: {
          visual_baseline: { type: "string" },
          highest_roi_opportunity: { type: "string" },
          training_priorities: { type: "array", items: namedInsight },
          posture_note: { type: "string" }
        }
      },
      photo_presence: {
        type: "object",
        additionalProperties: false,
        required: ["current_read", "liabilities", "corrective_actions"],
        properties: {
          current_read: { type: "string" },
          liabilities: { type: "array", items: namedInsight },
          corrective_actions: { type: "array", items: namedInsight }
        }
      },
      wardrobe: {
        type: "object",
        additionalProperties: false,
        required: ["keep", "stop_buying", "shopping_priorities"],
        properties: {
          keep: { type: "array", items: namedInsight },
          stop_buying: { type: "array", items: namedInsight },
          shopping_priorities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["item", "color_fit", "budget", "why"],
              properties: {
                item: { type: "string" },
                color_fit: { type: "string" },
                budget: { type: "string" },
                why: { type: "string" }
              }
            }
          }
        }
      },
      execution: {
        type: "object",
        additionalProperties: false,
        required: ["first_three_priorities", "seven_day_plan", "thirty_day_plan"],
        properties: {
          first_three_priorities: { type: "array", items: namedInsight },
          seven_day_plan: { type: "array", items: namedInsight },
          thirty_day_plan: { type: "array", items: namedInsight }
        }
      },
      final_directive: { type: "string" },
      disclaimer: { type: "string" }
    }
  };
}

function normalizeScoreItem(item, fallbackLabel) {
  const score = Number(item?.score);
  return {
    score: Number.isFinite(score) ? Math.max(1, Math.min(10, Math.round(score * 10) / 10)) : 5,
    label: cleanString(item?.label || fallbackLabel, 120),
    rationale: cleanString(item?.rationale || "Based on the submitted photos and context.", 700),
    first_fix: cleanString(item?.first_fix || "Make the highest-impact visible fix first.", 320)
  };
}

function normalizeInsight(item, index, fallbackTitle = "Priority") {
  return {
    title: cleanString(item?.title || `${fallbackTitle} ${index + 1}`, 140),
    why_it_matters: cleanString(item?.why_it_matters || "This changes the first read of your presentation.", 700),
    action: cleanString(item?.action || "Execute this before adding more complexity.", 420)
  };
}

function normalizeInsightList(value, count, fallbackTitle) {
  const items = Array.isArray(value) ? value : [];
  const normalized = items.slice(0, count).map((item, index) => normalizeInsight(item, index, fallbackTitle));
  while (normalized.length < count) {
    normalized.push(normalizeInsight(null, normalized.length, fallbackTitle));
  }
  return normalized;
}

function normalizeShoppingList(value) {
  const items = Array.isArray(value) ? value : [];
  const normalized = items.slice(0, 6).map((item, index) => ({
    item: cleanString(item?.item || `Priority item ${index + 1}`, 140),
    color_fit: cleanString(item?.color_fit || "Neutral color, clean fit, no loud graphics.", 220),
    budget: cleanString(item?.budget || "Match the submitted budget.", 120),
    why: cleanString(item?.why || "This helps the target look become easier to execute.", 420)
  }));

  while (normalized.length < 5) {
    normalized.push({
      item: `Priority item ${normalized.length + 1}`,
      color_fit: "Neutral color, clean fit.",
      budget: "Match the submitted budget.",
      why: "This fills a visible gap in the current wardrobe."
    });
  }

  return normalized;
}

function normalizeFullAudit(audit) {
  const normalized = { ...audit };
  normalized.status = ["completed", "needs_manual_review", "needs_better_photos"].includes(normalized.status) ? normalized.status : "completed";

  const summary = normalized.executive_summary || {};
  normalized.executive_summary = {
    current_baseline: normalizeScoreItem(summary.current_baseline, "Current baseline"),
    upgrade_potential: normalizeScoreItem(summary.upgrade_potential, "Upgrade potential"),
    primary_liability: cleanString(summary.primary_liability || "The current presentation lacks one clear visual direction.", 240),
    immediate_roi: cleanString(summary.immediate_roi || "Fix the most visible fit, grooming, or photo issue first.", 240),
    verdict: cleanString(summary.verdict || "Your baseline can improve quickly with a tighter system.", 700),
    summary: cleanString(summary.summary || "This audit gives a practical upgrade plan based on the submitted photos and goals.", 900)
  };

  const scorecard = normalized.scorecard || {};
  normalized.scorecard = {
    style_outfit_fit: normalizeScoreItem(scorecard.style_outfit_fit, "Style and outfit fit"),
    hair_architecture: normalizeScoreItem(scorecard.hair_architecture, "Hair architecture"),
    grooming_polish: normalizeScoreItem(scorecard.grooming_polish, "Grooming polish"),
    physique_proportion: normalizeScoreItem(scorecard.physique_proportion, "Physique and proportion"),
    digital_presence: normalizeScoreItem(scorecard.digital_presence, "Digital presence"),
    wardrobe_utility: normalizeScoreItem(scorecard.wardrobe_utility, "Wardrobe utility"),
    overall_brograde: normalizeScoreItem(scorecard.overall_brograde, "Overall BroGrade")
  };

  normalized.visual_assets = normalizeInsightList(normalized.visual_assets, 3, "Asset");
  normalized.visual_liabilities = normalizeInsightList(normalized.visual_liabilities, 3, "Liability");

  const styleFit = normalized.style_fit || {};
  normalized.style_fit = {
    current_read: cleanString(styleFit.current_read || "Current read is under-optimized.", 420),
    target_read: cleanString(styleFit.target_read || "Target read should be cleaner and more intentional.", 420),
    gap: cleanString(styleFit.gap || "The gap is mostly execution: fit, cohesion, grooming, and better photo translation.", 700),
    directives: normalizeInsightList(styleFit.directives, 4, "Style directive"),
    outfit_formulas: normalizeInsightList(styleFit.outfit_formulas, 3, "Outfit formula")
  };

  const hair = normalized.hair_grooming || {};
  normalized.hair_grooming = {
    recommended_cut: cleanString(hair.recommended_cut || "Use a cleaner cut that matches the face shape and target aesthetic.", 320),
    barber_instructions: cleanString(hair.barber_instructions || "Ask for cleaner side control, balanced top shape, and no drastic change without reference photos.", 700),
    grooming_moves: normalizeInsightList(hair.grooming_moves, 3, "Grooming move"),
    baseline_skin_protocol: normalizeInsightList(hair.baseline_skin_protocol, 3, "Baseline protocol")
  };

  const physique = normalized.physique_direction || {};
  normalized.physique_direction = {
    visual_baseline: cleanString(physique.visual_baseline || "Limited read from photos; focus on proportion and posture cues.", 420),
    highest_roi_opportunity: cleanString(physique.highest_roi_opportunity || "Build visible structure through shoulders, upper chest, back, and posture.", 420),
    training_priorities: normalizeInsightList(physique.training_priorities, 3, "Training priority"),
    posture_note: cleanString(physique.posture_note || "Keep shoulders relaxed, chest open, and neck stacked in photos.", 420)
  };

  const photoPresence = normalized.photo_presence || {};
  normalized.photo_presence = {
    current_read: cleanString(photoPresence.current_read || "Current photo presence can be sharpened with better light, angle, and expression.", 420),
    liabilities: normalizeInsightList(photoPresence.liabilities, 3, "Photo liability"),
    corrective_actions: normalizeInsightList(photoPresence.corrective_actions, 4, "Photo action")
  };

  const wardrobe = normalized.wardrobe || {};
  normalized.wardrobe = {
    keep: normalizeInsightList(wardrobe.keep, 2, "Keep"),
    stop_buying: normalizeInsightList(wardrobe.stop_buying, 3, "Stop buying"),
    shopping_priorities: normalizeShoppingList(wardrobe.shopping_priorities)
  };

  const execution = normalized.execution || {};
  normalized.execution = {
    first_three_priorities: normalizeInsightList(execution.first_three_priorities, 3, "First priority"),
    seven_day_plan: normalizeInsightList(execution.seven_day_plan, 7, "Day"),
    thirty_day_plan: normalizeInsightList(execution.thirty_day_plan, 4, "Week")
  };

  normalized.final_directive = cleanString(normalized.final_directive || "Execute the first three priorities before buying more or changing everything at once.", 900);
  normalized.disclaimer = cleanString(normalized.disclaimer || "BroGrade gives style, grooming, fitness-direction, and appearance feedback for self-improvement purposes only. It is not medical, mental health, dermatology, or professional fitness advice.", 700);

  return normalized;
}

function buildFullAuditPrompt(submission) {
  return [
    "Create a paid Full BroGrade Beta Audit from the uploaded images and user context.",
    "",
    "Brand voice: dark, direct, masculine, premium, practical, honest without being cruel. The user paid for specificity.",
    "Do not flatter. Do not shame. Do not use incel language, alpha language, medical claims, diagnosis, guaranteed dating/fitness results, or sensitive-trait inference.",
    "Review presentation only: clothing fit, silhouette, grooming, hair shape, photo presence, wardrobe direction, and general physique direction.",
    "If a category cannot be judged from the images, say limited read and still provide the safest useful next step.",
    "Make the paid audit clearly deeper than a free scan: exact first fixes, shopping priorities, outfit formulas, barber copy, photo retake rules, 7-day plan, and 30-day plan.",
    "Use concrete visible signals. Avoid generic lines like be confident, glow up, be yourself, or dress better.",
    "Score presentation, not human worth or genetic value. Use realistic 1 to 10 scores with one decimal.",
    "",
    "User context:",
    `First name: ${submission.first_name}`,
    `Age: ${submission.age}`,
    `Email: ${submission.email}`,
    `Main goal: ${submission.main_goal}`,
    `Target look: ${submission.target_look}`,
    `Focus areas: ${submission.focus_areas.join(", ")}`,
    `Wardrobe budget: ${submission.budget}`,
    `Primary environment: ${submission.primary_environment}`,
    `Current style: ${submission.current_style}`,
    `Biggest frustration: ${submission.biggest_frustration}`,
    `Desired outcome: ${submission.desired_outcome}`,
    `Liked brands/styles: ${submission.brands_liked || "Not provided"}`,
    `Avoided brands/styles: ${submission.brands_avoided || "Not provided"}`,
    `Hair context: ${submission.haircut_context || "Not provided"}`,
    `Gym context: ${submission.gym_context || "Not provided"}`,
    `Dating/photo context: ${submission.dating_context || "Not provided"}`,
    `City/climate: ${submission.city_climate || "Not provided"}`,
    `Height: ${submission.height || "Not provided"}`,
    `Weight: ${submission.weight || "Not provided"}`,
    "",
    "Output only structured JSON that matches the schema."
  ].join("\n");
}

async function createFullAuditWithModel(openai, model, submission, photos) {
  const content = [
    { type: "input_text", text: buildFullAuditPrompt(submission) }
  ];

  for (const photo of photos) {
    content.push({ type: "input_text", text: `Photo: ${photo.label}` });
    content.push({
      type: "input_image",
      image_url: `data:${photo.image.mimeType};base64,${photo.file.buffer.toString("base64")}`
    });
  }

  const response = await openai.responses.create({
    model,
    store: false,
    instructions: "You are BroGrade, a paid appearance presentation auditor for men 18+. Be specific, direct, useful, and safety-aware. Output JSON only.",
    input: [{ role: "user", content }],
    reasoning: { effort: AI_REASONING_EFFORT },
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "brograde_full_audit",
        description: "A paid BroGrade full appearance audit.",
        strict: true,
        schema: fullAuditSchema()
      }
    },
    max_output_tokens: 6000
  });

  const refusal = getOpenAiRefusal(response);
  if (refusal) {
    throw new Error(`OpenAI refused the full audit: ${refusal}`);
  }

  const outputText = response.output_text;
  if (!outputText) {
    throw new Error("OpenAI returned an empty full audit.");
  }

  return {
    response,
    full_audit: normalizeFullAudit(JSON.parse(outputText))
  };
}

async function generateFullAudit(submission, photos) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ai_status: "not_configured",
      model: null,
      full_audit: null,
      error: "OPENAI_API_KEY is not configured."
    };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const failures = [];

  for (const model of AI_MODELS) {
    try {
      const result = await createFullAuditWithModel(openai, model, submission, photos);
      return {
        ai_status: "completed",
        model,
        attempted_models: AI_MODELS,
        response_id: result.response.id,
        full_audit: result.full_audit
      };
    } catch (error) {
      failures.push({ model, message: error.message });
      if (!shouldTryNextModel(error)) break;
    }
  }

  const summary = failures.map((item) => `${item.model}: ${item.message}`).join(" | ");
  throw new Error(`OpenAI full audit failed after trying ${failures.length} model(s). ${summary}`);
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

function formatAuditPrice(cents = AUDIT_PRICE_CENTS, currency = AUDIT_CURRENCY) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase()
    }).format(Number(cents || 0) / 100);
  } catch (error) {
    return `$${(Number(cents || 0) / 100).toFixed(2)}`;
  }
}

function fullAuditText(audit) {
  if (!audit) return "Your full audit was submitted and is queued for review.";

  const scorecard = audit.scorecard || {};
  return [
    `Overall BroGrade: ${scorecard.overall_brograde?.score || "Pending"}/10`,
    `Primary Liability: ${audit.executive_summary.primary_liability}`,
    `Immediate ROI: ${audit.executive_summary.immediate_roi}`,
    "",
    "First three priorities:",
    ...audit.execution.first_three_priorities.map((item, index) => `${index + 1}. ${item.title}: ${item.action}`),
    "",
    audit.final_directive,
    "",
    audit.disclaimer
  ].join("\n");
}

function fullAuditSummaryHtml(record) {
  const audit = record.full_audit;
  if (!audit) {
    return "<p>Your full audit was submitted and is queued for review.</p>";
  }

  const priorities = audit.execution.first_three_priorities.map((item, index) => `
    <li>
      <strong>${index + 1}. ${escapeHtml(item.title)}</strong><br/>
      ${escapeHtml(item.action)}
    </li>
  `).join("");

  return `
    <p><strong>Overall BroGrade:</strong> ${escapeHtml(audit.scorecard.overall_brograde.score)}/10</p>
    <p><strong>Primary Liability:</strong> ${escapeHtml(audit.executive_summary.primary_liability)}</p>
    <p><strong>Immediate ROI:</strong> ${escapeHtml(audit.executive_summary.immediate_roi)}</p>
    <h3>First three priorities</h3>
    <ol>${priorities}</ol>
    <p>${escapeHtml(audit.final_directive)}</p>
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

async function deliverFullAuditEmails(record) {
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
  const submitted = new Date(record.created_at).toLocaleString("en-US", { timeZone: "America/Toronto" });
  const resultUrl = getAuditResultUrl(record);
  const photoLines = record.photos.map((photo) => `${photo.label}: ${getAuditPhotoAdminUrl(record, photo)}`);
  const photoHtml = record.photos.map((photo) => `
    <li><strong>${escapeHtml(photo.label)}:</strong> <a href="${escapeHtml(getAuditPhotoAdminUrl(record, photo))}">View private photo</a></li>
  `).join("");

  try {
    await sendEmail(resend, {
      from: process.env.RESEND_FROM,
      to: ADMIN_EMAIL,
      subject: `Paid BroGrade Full Audit: ${record.first_name}`,
      text: [
        "New Paid BroGrade Full Audit",
        "",
        `Name: ${record.first_name}`,
        `Age: ${record.age}`,
        `Email: ${record.email}`,
        `Goal: ${record.main_goal}`,
        `Target look: ${record.target_look}`,
        `Focus areas: ${record.focus_areas.join(", ")}`,
        `Budget: ${record.budget}`,
        `Environment: ${record.primary_environment}`,
        `Submitted: ${submitted}`,
        `Payment: ${record.payment_status} ${formatAuditPrice(record.payment_amount_total, record.payment_currency)}`,
        `Stripe session: ${record.checkout_session_id}`,
        `Result: ${resultUrl}`,
        "",
        "Photos:",
        ...photoLines,
        "",
        fullAuditText(record.full_audit)
      ].join("\n"),
      html: `
        <h2>New Paid BroGrade Full Audit</h2>
        <p><strong>Name:</strong> ${escapeHtml(record.first_name)}</p>
        <p><strong>Age:</strong> ${escapeHtml(record.age)}</p>
        <p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
        <p><strong>Goal:</strong> ${escapeHtml(record.main_goal)}</p>
        <p><strong>Target look:</strong> ${escapeHtml(record.target_look)}</p>
        <p><strong>Focus areas:</strong> ${escapeHtml(record.focus_areas.join(", "))}</p>
        <p><strong>Budget:</strong> ${escapeHtml(record.budget)}</p>
        <p><strong>Environment:</strong> ${escapeHtml(record.primary_environment)}</p>
        <p><strong>Submitted:</strong> ${escapeHtml(submitted)}</p>
        <p><strong>Payment:</strong> ${escapeHtml(record.payment_status)} ${escapeHtml(formatAuditPrice(record.payment_amount_total, record.payment_currency))}</p>
        <p><strong>Stripe session:</strong> ${escapeHtml(record.checkout_session_id)}</p>
        <p><a href="${escapeHtml(resultUrl)}">Open private audit result</a></p>
        <h3>Photos</h3>
        <ul>${photoHtml}</ul>
        <hr/>
        ${fullAuditSummaryHtml(record)}
      `
    });
    results.admin_sent = true;

    await sendEmail(resend, {
      from: process.env.RESEND_FROM,
      to: record.email,
      subject: record.full_audit ? "Your BroGrade Full Audit is ready" : "Your BroGrade Full Audit was submitted",
      text: [
        `Thanks for submitting your full BroGrade Audit, ${record.first_name}.`,
        "",
        record.full_audit ? `Your private result is ready: ${resultUrl}` : `Your audit is queued for review. Expected delivery: ${AUDIT_DELIVERY_WINDOW}.`,
        "",
        fullAuditText(record.full_audit),
        "",
        "BroGrade gives style, grooming, fitness-direction, and appearance feedback for self-improvement purposes only. It is not medical, mental health, dermatology, or professional fitness advice."
      ].join("\n"),
      html: `
        <h2>Your BroGrade Full Audit</h2>
        <p>Thanks for submitting your full BroGrade Audit, ${escapeHtml(record.first_name)}.</p>
        <p>${record.full_audit ? `Your private result is ready: <a href="${escapeHtml(resultUrl)}">Open your audit</a>` : `Your audit is queued for review. Expected delivery: ${escapeHtml(AUDIT_DELIVERY_WINDOW)}.`}</p>
        ${fullAuditSummaryHtml(record)}
        <hr/>
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
    ai_error: record.ai_error ? cleanString(record.ai_error, 500) : null,
    email_delivery: record.email_delivery,
    scan: record.scan || null
  };
}

function publicAuditRecord(record, options = {}) {
  const includeAudit = Boolean(options.includeAudit);
  const includePrivateUrl = Boolean(options.includePrivateUrl);

  return {
    id: record.id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: record.status,
    ai_status: record.ai_status,
    ai_model: record.ai_model,
    ai_error: record.ai_error ? cleanString(record.ai_error, 500) : null,
    email_delivery: record.email_delivery,
    payment_status: record.payment_status,
    payment_amount_total: record.payment_amount_total,
    payment_currency: record.payment_currency,
    delivery_window: AUDIT_DELIVERY_WINDOW,
    revision_policy: AUDIT_REVISION_POLICY,
    result_url: includePrivateUrl ? getAuditResultUrl(record) : null,
    full_audit: includeAudit ? record.full_audit || null : null
  };
}

function adminAuditRecord(record) {
  return {
    ...publicAuditRecord(record, { includeAudit: true, includePrivateUrl: true }),
    first_name: record.first_name,
    age: record.age,
    email: record.email,
    main_goal: record.main_goal,
    target_look: record.target_look,
    focus_areas: record.focus_areas,
    budget: record.budget,
    primary_environment: record.primary_environment,
    checkout_session_id: record.checkout_session_id,
    photos: record.photos.map((photo) => ({
      key: photo.key,
      label: photo.label,
      file_name: photo.file_name,
      size: photo.size,
      url: getAuditPhotoAdminUrl(record, photo)
    }))
  };
}

async function listFullAuditRecords() {
  const entries = await fsp.readdir(FULL_AUDITS_DIR, { withFileTypes: true }).catch(() => []);
  const records = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(await readAuditRecord(entry.name));
    } catch (error) {
      // Ignore incomplete folders.
    }
  }

  return records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function requireAdminSecret(req, res, next) {
  const provided = req.get("x-brograde-admin-secret") || req.query.secret;
  if (!process.env.SCAN_SIGNING_SECRET) {
    res.status(503).json({ ok: false, message: "SCAN_SIGNING_SECRET is not configured." });
    return;
  }

  if (!safeEquals(provided, process.env.SCAN_SIGNING_SECRET)) {
    res.status(403).json({ ok: false, message: "Invalid admin secret." });
    return;
  }

  next();
}

function safeCheckoutSessionId(value) {
  const sessionId = cleanString(value, 220);
  if (DEV_CHECKOUT_BYPASS && /^dev_audit_[0-9a-f-]{36}$/i.test(sessionId)) {
    return sessionId;
  }

  if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw fail("Invalid checkout session id.", 400);
  }
  return sessionId;
}

function createDevCheckoutSession({ email, firstName, scanId }) {
  const session = {
    id: `dev_audit_${crypto.randomUUID()}`,
    mode: "payment",
    payment_status: "paid",
    amount_total: AUDIT_PRICE_CENTS,
    currency: AUDIT_CURRENCY,
    customer_email: email || "",
    customer_details: {
      email: email || "",
      name: firstName || ""
    },
    metadata: {
      product: "full_audit",
      scan_id: scanId || "",
      first_name: firstName || "",
      source: "brograde_dev_bypass"
    }
  };

  devCheckoutSessions.set(session.id, session);
  return session;
}

async function retrievePaidCheckoutSession(sessionId) {
  if (DEV_CHECKOUT_BYPASS && sessionId.startsWith("dev_audit_")) {
    const session = devCheckoutSessions.get(sessionId);
    if (!session) throw fail("Dev checkout session not found. Start a new test audit.", 404);
    return session;
  }

  if (!stripe) {
    throw fail("Stripe checkout is not configured yet.", 503);
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session || session.mode !== "payment") throw fail("Invalid checkout session.", 400);
  if (session.payment_status !== "paid") throw fail("Payment is not complete yet.", 402);
  if (session.metadata?.product !== "full_audit") throw fail("Checkout session is not for a BroGrade Full Audit.", 400);

  return session;
}

function checkoutSessionPublicData(session) {
  return {
    id: session.id,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    customer_email: session.customer_details?.email || session.customer_email || "",
    customer_name: session.customer_details?.name || "",
    scan_id: session.metadata?.scan_id || ""
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
    stripe_configured: Boolean(stripe),
    dev_checkout_bypass: DEV_CHECKOUT_BYPASS,
    full_audit_price_cents: AUDIT_PRICE_CENTS,
    full_audit_currency: AUDIT_CURRENCY,
    storage_configured: Boolean(STORAGE_DIR),
    storage_dir: STORAGE_DIR
  });
});

app.get("/api/full-audit-config", (req, res) => {
  res.json({
    ok: true,
    data: {
      stripe_configured: Boolean(stripe),
      dev_checkout_bypass: DEV_CHECKOUT_BYPASS,
      price_cents: AUDIT_PRICE_CENTS,
      currency: AUDIT_CURRENCY,
      price_label: formatAuditPrice(),
      delivery_window: AUDIT_DELIVERY_WINDOW,
      revision_policy: AUDIT_REVISION_POLICY
    }
  });
});

app.post("/api/audit-checkout-session", apiLimiter, async (req, res, next) => {
  try {
    if (!stripe) throw fail("Stripe checkout is not configured yet.", 503);

    const email = cleanString(req.body?.email, 180).toLowerCase();
    const firstName = cleanString(req.body?.first_name, 80);
    const scanId = cleanString(req.body?.scan_id, 80);
    if (email && !isEmail(email)) throw fail("Enter a valid email address.");
    if (scanId && !/^[0-9a-f-]{36}$/i.test(scanId)) throw fail("Invalid free scan id.");

    const scanParam = scanId ? `&scan_id=${encodeURIComponent(scanId)}` : "";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email || undefined,
      client_reference_id: scanId || undefined,
      line_items: [
        {
          price_data: {
            currency: AUDIT_CURRENCY,
            unit_amount: AUDIT_PRICE_CENTS,
            product_data: {
              name: "Full BroGrade Beta Audit",
              description: "Personalized style, grooming, physique-direction, photo, wardrobe, and execution plan."
            }
          },
          quantity: 1
        }
      ],
      allow_promotion_codes: true,
      metadata: {
        product: "full_audit",
        scan_id: scanId,
        first_name: firstName,
        source: "brograde_site"
      },
      success_url: `${PUBLIC_BASE_URL}/audit-intake.html?session_id={CHECKOUT_SESSION_ID}${scanParam}`,
      cancel_url: `${PUBLIC_BASE_URL}/audit.html?checkout=cancelled${scanParam}`
    });

    res.status(201).json({
      ok: true,
      data: {
        id: session.id,
        url: session.url
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dev-audit-checkout-session", apiLimiter, async (req, res, next) => {
  try {
    if (!DEV_CHECKOUT_BYPASS) throw fail("Dev checkout bypass is not enabled.", 404);

    const email = cleanString(req.body?.email, 180).toLowerCase();
    const firstName = cleanString(req.body?.first_name, 80);
    const scanId = cleanString(req.body?.scan_id, 80);
    if (email && !isEmail(email)) throw fail("Enter a valid email address.");
    if (scanId && !/^[0-9a-f-]{36}$/i.test(scanId)) throw fail("Invalid free scan id.");

    const session = createDevCheckoutSession({ email, firstName, scanId });
    const scanParam = scanId ? `&scan_id=${encodeURIComponent(scanId)}` : "";

    res.status(201).json({
      ok: true,
      data: {
        id: session.id,
        url: `${PUBLIC_BASE_URL}/audit-intake.html?session_id=${encodeURIComponent(session.id)}${scanParam}`
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/audit-checkout-session/:sessionId", async (req, res, next) => {
  try {
    const sessionId = safeCheckoutSessionId(req.params.sessionId);
    const session = await retrievePaidCheckoutSession(sessionId);
    res.json({
      ok: true,
      data: checkoutSessionPublicData(session)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/ai-check", requireAdminSecret, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(503).json({
      ok: false,
      message: "OPENAI_API_KEY is not configured.",
      attempted_models: AI_MODELS
    });
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const failures = [];

  for (const model of AI_MODELS) {
    try {
      const response = await openai.responses.create({
        model,
        store: false,
        instructions: "Return exactly the requested confirmation text.",
        input: "Reply with exactly: BroGrade AI ready",
        reasoning: { effort: AI_REASONING_EFFORT },
        max_output_tokens: 24
      });

      const text = (response.output_text || "").trim();
      if (!/BroGrade AI ready/i.test(text)) {
        throw new Error(`Unexpected model response: ${text || "empty output"}`);
      }

      res.json({
        ok: true,
        model,
        attempted_models: AI_MODELS,
        response_id: response.id
      });
      return;
    } catch (error) {
      failures.push({ model, message: error.message });
      if (!shouldTryNextModel(error)) break;
    }
  }

  res.status(502).json({
    ok: false,
    message: "OpenAI check failed.",
    attempted_models: AI_MODELS,
    failures
  });
});

app.post("/api/full-audits", apiLimiter, auditUpload.fields(auditPhotoUploadFields), async (req, res, next) => {
  try {
    const sessionId = safeCheckoutSessionId(req.body.checkout_session_id);
    const checkoutSession = await retrievePaidCheckoutSession(sessionId);
    const checkoutData = checkoutSessionPublicData(checkoutSession);
    const submission = validateAuditSubmission(req.body, req.files);

    if (checkoutData.customer_email && checkoutData.customer_email.toLowerCase() !== submission.email) {
      throw fail("Use the same email address you used at checkout.", 400);
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const resultToken = crypto.randomBytes(24).toString("hex");
    const auditDir = path.join(FULL_AUDITS_DIR, id);
    const photosDir = path.join(auditDir, "photos");
    await fsp.mkdir(photosDir, { recursive: true });

    const savedPhotos = [];
    for (const photo of submission.photos) {
      const photoPath = path.join(photosDir, `${photo.key}${photo.image.extension}`);
      await fsp.writeFile(photoPath, photo.file.buffer);
      savedPhotos.push({
        key: photo.key,
        label: photo.label,
        file_name: photo.file.originalname,
        mime_type: photo.image.mimeType,
        size: photo.file.size,
        path: photoPath
      });
    }

    let freeScanSnapshot = null;
    if (submission.scan_id) {
      try {
        const freeScanRecord = await readRecord(submission.scan_id);
        freeScanSnapshot = publicRecord(freeScanRecord);
      } catch (error) {
        freeScanSnapshot = null;
      }
    }

    let aiResult;
    try {
      aiResult = await generateFullAudit(submission, submission.photos);
    } catch (error) {
      console.error("AI full audit failed:", error);
      aiResult = {
        ai_status: "failed",
        model: AI_MODEL,
        full_audit: null,
        error: error.message
      };
    }

    const record = {
      id,
      result_token: resultToken,
      created_at: createdAt,
      updated_at: createdAt,
      first_name: submission.first_name,
      age: submission.age,
      email: submission.email,
      height: submission.height,
      weight: submission.weight,
      checkout_session_id: submission.checkout_session_id,
      payment_status: checkoutData.payment_status,
      payment_amount_total: checkoutData.amount_total,
      payment_currency: checkoutData.currency,
      scan_id: submission.scan_id,
      free_scan_snapshot: freeScanSnapshot,
      main_goal: submission.main_goal,
      target_look: submission.target_look,
      focus_areas: submission.focus_areas,
      budget: submission.budget,
      primary_environment: submission.primary_environment,
      current_style: submission.current_style,
      biggest_frustration: submission.biggest_frustration,
      desired_outcome: submission.desired_outcome,
      brands_liked: submission.brands_liked,
      brands_avoided: submission.brands_avoided,
      haircut_context: submission.haircut_context,
      gym_context: submission.gym_context,
      dating_context: submission.dating_context,
      city_climate: submission.city_climate,
      photos: savedPhotos,
      marketing_permission: submission.marketing_permission,
      consent_age_confirmed: submission.consent_age_confirmed,
      consent_disclaimer_confirmed: submission.consent_disclaimer_confirmed,
      status: aiResult.full_audit ? "ready" : "submitted",
      ai_status: aiResult.ai_status,
      ai_model: aiResult.model,
      ai_attempted_models: aiResult.attempted_models || AI_MODELS,
      ai_response_id: aiResult.response_id || null,
      ai_error: aiResult.error || null,
      full_audit: aiResult.full_audit,
      email_delivery: null
    };

    await writeJsonAtomic(getAuditRecordPath(id), record);
    if (record.full_audit) {
      await writeJsonAtomic(path.join(auditDir, "result.json"), record.full_audit);
    }

    const emailDelivery = await deliverFullAuditEmails(record);
    record.email_delivery = emailDelivery;
    record.updated_at = new Date().toISOString();
    await writeJsonAtomic(getAuditRecordPath(id), record);

    res.status(201).json({
      ok: true,
      message: record.full_audit ? "Your BroGrade Full Audit is ready." : "Your BroGrade Full Audit was submitted.",
      data: publicAuditRecord(record, { includeAudit: Boolean(record.full_audit), includePrivateUrl: true })
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/full-audits/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail("Invalid audit id.", 400);

    const record = await readAuditRecord(id);
    if (!safeEquals(req.query.token, record.result_token)) throw fail("Invalid audit token.", 403);

    res.json({
      ok: true,
      data: publicAuditRecord(record, { includeAudit: true })
    });
  } catch (error) {
    next(error);
  }
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

app.get("/api/admin/full-audits", requireAdminSecret, async (req, res, next) => {
  try {
    const records = await listFullAuditRecords();
    res.json({
      ok: true,
      data: records.map((record) => adminAuditRecord(record))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/full-audits/:id", requireAdminSecret, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail("Invalid audit id.", 400);
    const record = await readAuditRecord(id);
    res.json({
      ok: true,
      data: adminAuditRecord(record)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/full-audits/:id/photo/:photoKey", async (req, res, next) => {
  try {
    const { id, photoKey } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail("Invalid audit id.", 400);
    if (!auditPhotoFields.some((field) => field.name === photoKey)) throw fail("Invalid audit photo key.", 400);
    if (!safeEquals(req.query.token, signAuditPhotoToken(id, photoKey))) throw fail("Invalid photo token.", 403);

    const record = await readAuditRecord(id);
    const photo = record.photos.find((item) => item.key === photoKey);
    if (!photo) throw fail("Photo not found.", 404);

    res.type(photo.mime_type);
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(photo.path);
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

app.get("/audit", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "audit.html"));
});

app.get("/audit-intake", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "audit-intake.html"));
});

app.get("/audit-success", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "audit-success.html"));
});

app.get("/audit-result", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "audit-result.html"));
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
    message: status >= 500 && !error.status ? "Something went wrong while submitting your request." : error.message
  });
});

app.listen(PORT, () => {
  console.log(`BroGrade running at http://localhost:${PORT}`);
  console.log(`Free scan endpoint: http://localhost:${PORT}/api/free-looks-scans`);
});
