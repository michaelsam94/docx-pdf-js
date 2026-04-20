import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileFromLegacyAi } from "./cv-docx-style.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Optional LLM pass: tailors resume + job description into structured CV fields.
 *
 * Providers:
 * - **cursor** — `CURSOR_API_KEY` + Cursor [Cloud Agents API](https://api.cursor.com): launches an agent
 *   on a GitHub repo (`CURSOR_REPOSITORY` or auto from `git remote get-url origin`), polls until FINISHED,
 *   then reads JSON from the agent conversation.
 * - **openai** / **anthropic** — direct HTTP APIs (same keys you can add in Cursor → Settings → Models).
 */

const SYSTEM = `You are an expert resume editor. You rewrite and tailor CV content for a specific job.
Rules:
- Do not invent employers, degrees, dates, or tools the candidate did not imply in the resume text.
- You may reorder emphasis, tighten wording, and align bullets with the job description.
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

/** GitHub HTTPS URL for Cursor Cloud Agents, or null. */
function resolveCursorRepository() {
  return (
    process.env.CURSOR_REPOSITORY ||
    process.env.GITHUB_REPOSITORY ||
    process.env.GITHUB_REPO_URL ||
    githubHttpsFromGitOrigin() ||
    null
  );
}

function pickProvider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "cursor") return "cursor";
  if (p === "anthropic") return "anthropic";
  if (p === "openai") return "openai";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.CURSOR_API_KEY && resolveCursorRepository()) return "cursor";
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @returns {string | null} */
function githubHttpsFromGitOrigin() {
  try {
    const raw = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw.startsWith("https://github.com/")) {
      return raw.replace(/\.git$/, "");
    }
    if (raw.startsWith("git@github.com:")) {
      const pathPart = raw.slice("git@github.com:".length).replace(/\.git$/, "");
      return `https://github.com/${pathPart}`;
    }
  } catch {
    /* not a git repo or no origin */
  }
  return null;
}

function cursorBasicAuthHeader() {
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("CURSOR_API_KEY is not set.");
  return `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
}

async function callCursorCloudAgent(resumeText, jobDescription) {
  const repo = resolveCursorRepository();
  if (!repo) {
    const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    throw new Error(
      "Cursor Cloud Agents need a GitHub repository URL, but none was found.\n\n" +
        "Add this to your `.env` (uncomment and set your real repo):\n" +
        "  CURSOR_REPOSITORY=https://github.com/YOUR_USER/YOUR_REPO\n\n" +
        "This project folder is not a git clone (or `origin` is not GitHub), so the URL cannot be detected automatically.\n\n" +
        (hasOpenAi || hasAnthropic
          ? "Alternatively, set AI_PROVIDER=openai (or anthropic) in `.env` to use direct API calls instead of Cursor agents.\n"
          : "To use OpenAI instead, add OPENAI_API_KEY to `.env` and set AI_PROVIDER=openai.\n"),
    );
  }

  const auth = cursorBasicAuthHeader();
  const ref = process.env.CURSOR_REF || "main";
  const model = process.env.CURSOR_MODEL || "default";
  const maxWaitMs = Number(process.env.CURSOR_AGENT_MAX_WAIT_MS || 600_000);
  const pollMs = Number(process.env.CURSOR_AGENT_POLL_MS || 8_000);

  const promptText = `${SYSTEM}

${buildUserContent(resumeText, jobDescription)}

Important: Do not modify repository files or open a pull request for this task. Reply with only the JSON object (you may wrap it in a single \`\`\`json code block).`;

  const launchRes = await fetch("https://api.cursor.com/v0/agents", {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: { text: promptText },
      model,
      source: { repository: repo, ref },
    }),
  });

  const launchText = await launchRes.text();
  if (!launchRes.ok) {
    throw new Error(`Cursor Cloud Agents HTTP ${launchRes.status}: ${launchText.slice(0, 1200)}`);
  }
  let launchJson;
  try {
    launchJson = JSON.parse(launchText);
  } catch {
    throw new Error(`Cursor launch response was not JSON: ${launchText.slice(0, 400)}`);
  }
  const id = launchJson.id;
  if (!id) {
    throw new Error(`Cursor launch response missing id: ${launchText.slice(0, 500)}`);
  }

  const start = Date.now();
  let finished = false;
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const stRes = await fetch(`https://api.cursor.com/v0/agents/${id}`, {
      headers: { Authorization: auth },
    });
    const stText = await stRes.text();
    if (!stRes.ok) {
      throw new Error(`Cursor agent status HTTP ${stRes.status}: ${stText.slice(0, 800)}`);
    }
    const st = JSON.parse(stText);
    const status = String(st.status || "").toUpperCase();
    if (status === "FINISHED") {
      finished = true;
      break;
    }
    if (
      status === "FAILED" ||
      status === "ERROR" ||
      status === "CANCELLED" ||
      status === "DELETED"
    ) {
      throw new Error(
        `Cursor agent ${id} ended with status ${st.status}: ${stText.slice(0, 1200)}`,
      );
    }
  }

  if (!finished) {
    throw new Error(
      `Cursor agent ${id} did not reach FINISHED within ${maxWaitMs}ms. Increase CURSOR_AGENT_MAX_WAIT_MS or check the agent in the Cursor dashboard.`,
    );
  }

  const convRes = await fetch(`https://api.cursor.com/v0/agents/${id}/conversation`, {
    headers: { Authorization: auth },
  });
  const convText = await convRes.text();
  if (!convRes.ok) {
    throw new Error(`Cursor conversation HTTP ${convRes.status}: ${convText.slice(0, 800)}`);
  }
  const conv = JSON.parse(convText);
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const assistants = messages
    .filter((m) => m.type === "assistant_message" && m.text)
    .map((m) => String(m.text));

  for (let i = assistants.length - 1; i >= 0; i--) {
    const raw = assistants[i].trim();
    try {
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonStr = fence ? fence[1].trim() : raw;
      return jsonToProfile(JSON.parse(jsonStr));
    } catch {
      /* try earlier assistant message */
    }
  }

  throw new Error(
    `Could not parse CV JSON from Cursor agent ${id} conversation. Last assistant snippet: ${assistants.at(-1)?.slice(0, 500) || "(none)"}`,
  );
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

/**
 * @param {{ resumeText: string, jobDescription: string }} input
 * @returns {Promise<{ profile: Record<string, unknown> }>}
 */
export async function generateTailoredCvWithAi(input) {
  const { resumeText, jobDescription } = input;
  const provider = pickProvider();
  if (!provider) {
    if (process.env.CURSOR_API_KEY && !resolveCursorRepository()) {
      throw new Error(
        "CURSOR_API_KEY is set, but Cursor Cloud Agents need a GitHub repo URL.\n\n" +
          "Add to `.env`:\n" +
          "  CURSOR_REPOSITORY=https://github.com/YOUR_USER/YOUR_REPO\n\n" +
          "Or use OpenAI instead (no repo required):\n" +
          "  OPENAI_API_KEY=sk-...\n" +
          "  AI_PROVIDER=openai\n",
      );
    }
    throw new Error(
      "No AI provider is configured.\n\n" +
        "Add to `.env` (see `.env.example`):\n" +
        "  • OPENAI_API_KEY — recommended for CV generation, or\n" +
        "  • ANTHROPIC_API_KEY, or\n" +
        "  • CURSOR_API_KEY + CURSOR_REPOSITORY (Cloud Agents only work with a GitHub repo)\n\n" +
        "Optional: AI_PROVIDER=openai|anthropic|cursor when multiple keys exist.",
    );
  }
  let profile;
  if (provider === "cursor") {
    profile = await callCursorCloudAgent(resumeText, jobDescription);
  } else if (provider === "openai") {
    profile = await callOpenAI(resumeText, jobDescription);
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
