import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileFromLegacyAi } from "./cv-docx-style.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Optional LLM pass: tailors resume + job description into structured CV fields.
 *
 * **OpenAI** — `OPENAI_API_KEY` + `https://api.openai.com/v1/chat/completions` (or any OpenAI-compatible
 * base URL via `OPENAI_BASE_URL`).
 *
 * **Anthropic** — `ANTHROPIC_API_KEY` + Messages API.
 *
 * **Gemini** — `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) + Google AI `generateContent` (`GEMINI_MODEL`, default `gemini-flash-latest`).
 *
 * These are the same kinds of keys you can add in **Cursor → Settings → Models**. Cursor does **not**
 * publish a general “chat with the LLM” HTTP API for dashboard `key_…` keys; those keys are for Cursor’s own
 * services (Cloud Agents with a GitHub repo, Admin, etc.). For this script, use OpenAI or Anthropic directly.
 */

const SYSTEM = `You are an expert resume editor. You map the candidate's source resume into structured CV JSON for a specific job.
Strict rules:
- Copy every real-world fact from the resume source: full name, contact, employers, locations, dates, degrees, certifications, product names, metrics, and tech stack. Never substitute placeholders (no example.com, no 555 phone numbers, no fictional employers).
- Preserve the candidate's primary platform and seniority from the source (e.g. Android/Kotlin-heavy stays that way). Do not "balance" into a generic iOS+Android profile unless the source clearly covers both.
- You may tighten wording, split/join lines for clarity, and reorder bullets for job fit — but each bullet must remain faithful to something stated or clearly implied in the source; do not invent achievements.
- Include every employment block from the source in "jobs" in the same chronological order unless the user text is clearly reverse-chronological (then keep that order).
- Return ONLY valid JSON, no markdown fences, no commentary.`;

const JSON_INSTRUCTION = `Return ONE JSON object for a styled Word CV (Arial, sections, job blocks).

PREFERRED full schema:
- "name" (string): header name
- "subtitle" (string): role line under name
- "contact_line" (string): e.g. "City · Remote · email · phone" (use · separators where helpful)
- "links": [ {"text": "LinkedIn", "url": "https://..."}, ... ] (can be [])
- "professional_summary" (string): 2–5 sentences
- "role_fit" (string): one short paragraph tailored to the job (truthful)
- "core_skills": [ {"label": "Android & Mobile", "value": "Kotlin, ..."}, ... ] — grouped rows
- "featured_project": null OR {"title","url","url_label","description"}
- "jobs": [ {"title","company","period","bullets": ["achievement...", ...] }, ... ] — each job MUST have non-empty bullets
- "technical_tooling": [ {"label","value"}, ... ] (optional)
- "education": null OR {"degree_line": "...", "bullets": ["...", ...]}

FALLBACK compact schema (we map it automatically): "title", "summary", "skills", "experience" (string[]), "role_fit" — same rules as before; "title" can be "Name — Role" in one string.`;

function pickProvider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "cursor") {
    throw new Error(
      "AI_PROVIDER=cursor is not supported in this script.\n\n" +
        "Cursor does not provide a general-purpose LLM HTTP API for dashboard API keys. " +
        "Use OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY — the same providers you can configure in Cursor → Settings → Models.",
    );
  }
  if (p === "anthropic") return "anthropic";
  if (p === "openai") return "openai";
  if (p === "gemini" || p === "google") return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  return null;
}

function buildUserContent(resumeText, jobDescription) {
  return `${JSON_INSTRUCTION}

### Resume source (may include TITLE/SUMMARY/SKILLS/EXPERIENCE sections)
${resumeText}

### Job description
${jobDescription}`;
}

function validateStyledProfile(raw) {
  const name = String(raw.name || "").trim();
  if (!name) {
    throw new Error('Full CV JSON must include non-empty "name".');
  }
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  const normJobs = jobs.map((j) => ({
    title: String(j?.title || "").trim(),
    company: String(j?.company || "").trim(),
    period: String(j?.period || "").trim(),
    bullets: (Array.isArray(j?.bullets) ? j.bullets : [])
      .map((b) => String(b).trim())
      .filter(Boolean),
  }));
  if (!normJobs.some((j) => j.bullets.length)) {
    throw new Error('Full CV JSON needs "jobs" with at least one non-empty "bullets" array.');
  }
  const links = Array.isArray(raw.links)
    ? raw.links
        .map((l) => ({
          text: String(l?.text || "").trim(),
          url: String(l?.url || "").trim(),
        }))
        .filter((l) => l.text && l.url)
    : [];
  const core_skills = Array.isArray(raw.core_skills) && raw.core_skills.length
    ? raw.core_skills.map((r) => ({
        label: String(r?.label || "").trim() || "Skills",
        value: String(r?.value || "").trim() || "—",
      }))
    : [{ label: "Skills", value: "—" }];
  const technical_tooling = Array.isArray(raw.technical_tooling)
    ? raw.technical_tooling
        .map((r) => ({
          label: String(r?.label || "").trim(),
          value: String(r?.value || "").trim(),
        }))
        .filter((r) => r.label)
    : [];
  const education =
    raw.education && typeof raw.education === "object"
      ? {
          degree_line: String(raw.education.degree_line || "").trim(),
          bullets: Array.isArray(raw.education.bullets)
            ? raw.education.bullets.map((b) => String(b).trim()).filter(Boolean)
            : [],
        }
      : null;
  return {
    name,
    subtitle: String(raw.subtitle || "").trim(),
    contact_line: String(raw.contact_line || "").trim(),
    links,
    professional_summary: String(raw.professional_summary || "").trim() || "—",
    role_fit: String(raw.role_fit || raw.roleFit || "").trim(),
    core_skills,
    featured_project: raw.featured_project && typeof raw.featured_project === "object" ? raw.featured_project : null,
    jobs: normJobs,
    technical_tooling,
    education,
  };
}

function jsonToProfile(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned invalid JSON (not an object).");
  }
  if (Array.isArray(raw.jobs) && raw.jobs.length > 0 && String(raw.name || "").trim()) {
    return validateStyledProfile(raw);
  }
  const title = String(raw.title || "").trim();
  const summary = String(raw.summary || "").trim();
  const skills = String(raw.skills || "").trim();
  const role_fit = String(raw.role_fit || raw.roleFit || "").trim();
  let experience = raw.experience;
  if (!Array.isArray(experience)) {
    throw new Error(
      'AI JSON must use full schema ("name" + "jobs") or compact schema with "experience" as an array.',
    );
  }
  experience = experience.map((s) => String(s).trim()).filter(Boolean);
  if (!title || !summary || !skills || experience.length === 0 || !role_fit) {
    throw new Error(
      'Compact schema needs non-empty "title", "summary", "skills", "experience" (array), and "role_fit".',
    );
  }
  return profileFromLegacyAi({ title, summary, skills, experience, role_fit });
}

async function callOpenAI(resumeText, jobDescription) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: Number(process.env.AI_TEMPERATURE || 0.35),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserContent(resumeText, jobDescription) },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI response was not JSON: ${text.slice(0, 200)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Unexpected OpenAI response shape: ${text.slice(0, 400)}`);
  }
  return jsonToProfile(JSON.parse(content));
}

async function callAnthropic(resumeText, jobDescription) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  const model =
    process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: Number(process.env.AI_TEMPERATURE || 0.35),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildUserContent(resumeText, jobDescription) }],
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  const data = JSON.parse(text);
  const blocks = data.content;
  const block = Array.isArray(blocks) ? blocks.find((b) => b.type === "text") : null;
  const rawText = block?.text?.trim() || "";
  if (!rawText) {
    throw new Error(`Unexpected Anthropic response: ${text.slice(0, 400)}`);
  }
  let jsonStr = rawText;
  const fence = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonStr = fence[1].trim();
  return jsonToProfile(JSON.parse(jsonStr));
}

function geminiApiKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

/** Appends human hints for common `fetch` failures (ENOTFOUND, timeouts). */
function explainFetchFailure(err, apiName, hostname) {
  const cause = err && typeof err === "object" && "cause" in err ? err.cause : null;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  const host =
    hostname ||
    (cause && typeof cause === "object" && "hostname" in cause ? String(cause.hostname) : "");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return (
      `\n\n${apiName}: DNS could not resolve ${host || "the API host"} (${code}). ` +
      "This is a network/DNS issue on your machine, not the API key.\n" +
      "Try: confirm Wi‑Fi/Ethernet, disconnect VPN or try another network, " +
      "or set system DNS to 1.1.1.1 / 8.8.8.8. Verify with:\n" +
      `  dig ${host || "generativelanguage.googleapis.com"} +short\n` +
      "If you must use an HTTP(S) proxy, configure it for Node (e.g. HTTPS_PROXY) so `fetch` can reach Google."
    );
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET") {
    return `\n\n${apiName}: connection ${code} to ${host || "API"}. Check VPN, firewall, or captive portal.`;
  }
  return "";
}

async function callGemini(resumeText, jobDescription) {
  const key = geminiApiKey();
  if (!key) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.");
  const model = (process.env.GEMINI_MODEL || "gemini-flash-latest").replace(/^models\//, "");
  const base =
    (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  let hostname = "generativelanguage.googleapis.com";
  try {
    hostname = new URL(base.startsWith("http") ? base : `https://${base}`).hostname;
  } catch {
    /* keep default */
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [{ text: buildUserContent(resumeText, jobDescription) }],
          },
        ],
        generationConfig: {
          temperature: Number(process.env.AI_TEMPERATURE || 0.35),
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    const baseMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`${baseMsg}${explainFetchFailure(e, "Gemini", hostname)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Gemini response was not JSON: ${text.slice(0, 200)}`);
  }
  const parts = data.candidates?.[0]?.content?.parts;
  const rawText = Array.isArray(parts)
    ? parts.map((p) => p?.text).filter(Boolean).join("")
    : "";
  if (!rawText.trim()) {
    throw new Error(`Unexpected Gemini response: ${text.slice(0, 400)}`);
  }
  let jsonStr = rawText.trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonStr = fence[1].trim();
  return jsonToProfile(JSON.parse(jsonStr));
}

/**
 * @param {{ resumeText: string, jobDescription: string }} input
 * @returns {Promise<{ profile: Record<string, unknown> }>}
 */
export async function generateTailoredCvWithAi(input) {
  const { resumeText, jobDescription } = input;
  const provider = pickProvider();
  if (!provider) {
    throw new Error(
      "No LLM API key is configured.\n\n" +
        "Add to `.env` (see `.env.example`):\n" +
        "  OPENAI_API_KEY=sk-...\n" +
        "or\n" +
        "  ANTHROPIC_API_KEY=sk-ant-...\n" +
        "or\n" +
        "  GEMINI_API_KEY=...   (Google AI Studio)\n\n" +
        "Optional: OPENAI_BASE_URL; AI_PROVIDER=openai|anthropic|gemini when several keys exist.\n\n" +
        "Note: CURSOR_API_KEY / Cursor dashboard keys are not used here — there is no Cursor-hosted chat API for arbitrary scripts.",
    );
  }
  let profile;
  if (provider === "openai") {
    profile = await callOpenAI(resumeText, jobDescription);
  } else if (provider === "gemini") {
    profile = await callGemini(resumeText, jobDescription);
  } else {
    profile = await callAnthropic(resumeText, jobDescription);
  }
  return { profile };
}

function loadRootEnvFile() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

async function runCli() {
  loadRootEnvFile();
  const resumePath = path.join(projectRoot, "data", "resume.txt");
  const descPath = path.join(projectRoot, "data", "description.txt");
  if (!fs.existsSync(resumePath)) {
    throw new Error(`Missing ${resumePath}`);
  }
  if (!fs.existsSync(descPath)) {
    throw new Error(`Missing ${descPath}`);
  }
  const resumeText = fs.readFileSync(resumePath, "utf8");
  const jobDescription = fs.readFileSync(descPath, "utf8").trim();
  const { profile } = await generateTailoredCvWithAi({ resumeText, jobDescription });
  console.log(JSON.stringify(profile, null, 2));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runCli().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
