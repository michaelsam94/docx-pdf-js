/**
 * Builds a CV from ./data/resume.txt and ./data/description.txt, writes the DOCX, then runs LibreOffice
 * on that file to produce the PDF (same folder, same basename).
 *
 * Prerequisite (macOS): LibreOffice for PDF. On Apple Silicon (M1/M2/M3) use the **Apple Silicon** build
 * (`brew install --cask libreoffice` on Homebrew arm64, or LibreOffice’s “AArch64” download — not the Intel DMG).
 * If PDF conversion dies with SIGKILL from an integrated terminal, `npm run build` still exits 0
 * (DOCX is kept). Generate the PDF with `npm run pdf` in Terminal.app, or set STRICT_BUILD=1 to fail
 * the script when PDF conversion does not succeed.
 *
 * Usage:
 *   npm install
 *   npm run build
 *
 * Inputs:
 *   ./data/resume.txt — either legacy blocks (TITLE, SUMMARY, SKILLS, EXPERIENCE with "- " bullets) or a narrative CV
 *     with lines like PROFESSIONAL SUMMARY, CORE SKILLS, FEATURED PROJECT, PROFESSIONAL EXPERIENCE (role + company +
 *     "• " bullets; wrapped bullet lines without "• " are merged into the previous bullet). Save the file before `npm run build`.
 *   ./data/description.txt — job description; used for role-fit wording and bullet ordering (non-AI) or AI tailoring (USE_AI=1)
 *
 * Outputs:
 *   ./out/michael_samuel_cv.docx
 *   ./out/michael_samuel_cv.pdf
 *
 * CV layout: default is **styled** (Arial, accent rules, job blocks, numbered bullets like the reference template).
 * Set CV_LAYOUT=simple for the older minimal headings + bullets layout.
 *
 * AI tailoring (optional), USE_AI=1:
 *   • OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY (optional *_MODEL / OPENAI_BASE_URL / GEMINI_API_BASE_URL).
 *   • AI_PROVIDER=openai|anthropic|gemini when several keys are set.
 *   • Optional: create `.env` in the project root with those variables — it is loaded automatically
 *     (shell exports still win if the variable is already set).
 *
 * Fixed contact (styled DOCX only), USE_FIXED_CONTACT=1 in `.env`:
 *   CONTACT_PHONE, CONTACT_PORTFOLIO, CONTACT_LINKEDIN, CONTACT_GITHUB, CONTACT_EMAIL — overrides preamble / AI
 *   for the gray contact line (phone · email) and hyperlink row (Portfolio, LinkedIn, GitHub).
 *
 * Fixed featured project (MegaPlug / Play Store), USE_FIXED_FEATURED_PROJECT=1:
 *   FEATURED_PROJECT_URL (e.g. play.google.com/.../id=com.mega.plug) plus optional FEATURED_PROJECT_TITLE,
 *   FEATURED_PROJECT_URL_LABEL, FEATURED_PROJECT_DESCRIPTION — overrides URL (and optional fields) for the
 *   Featured Project section; merges title/description from resume or AI when overrides are omitted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { generateTailoredCvWithAi } from "./ai-cv.mjs";
import { createStyledCvDocumentBuffer, profileFromParsedResume } from "./cv-docx-style.mjs";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "out");
const dataDir = path.join(root, "data");
const resumePath = path.join(dataDir, "resume.txt");
const descriptionPath = path.join(dataDir, "description.txt");
const outputBase = "michael_samuel_cv";

/** Load `./.env` into `process.env` without overriding variables already set (e.g. from the shell). */
function loadRootEnvFile() {
  const envPath = path.join(root, ".env");
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

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "that",
  "this",
  "from",
  "are",
  "our",
  "will",
  "have",
  "has",
  "been",
  "was",
  "were",
  "your",
  "their",
  "they",
  "who",
  "what",
  "when",
  "where",
  "which",
  "into",
  "also",
  "such",
  "than",
  "then",
  "using",
  "work",
  "team",
  "teams",
  "strong",
  "plus",
  "role",
  "hire",
  "hiring",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeToken(w) {
  return w.toLowerCase().replace(/[^a-z0-9+#.]/g, "");
}

function tokens(text) {
  return (String(text).match(/[a-zA-Z0-9+#.]+/g) || [])
    .map(normalizeToken)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function descriptionTokenSet(description) {
  return new Set(tokens(description));
}

const SECTION_HEADER_TYPES = [
  ["EDUCATION & CERTIFICATIONS", "education"],
  ["PROFESSIONAL SUMMARY", "summary"],
  ["PROFESSIONAL EXPERIENCE", "experience"],
  ["FEATURED PROJECT", "featured"],
  ["TECHNICAL TOOLING", "tooling"],
  ["CORE SKILLS", "skills"],
  ["TITLE", "title"],
  ["SUMMARY", "summary"],
  ["SKILLS", "skills"],
  ["EXPERIENCE", "experience"],
  ["EDUCATION", "education"],
];

/** @param {string} line */
function resumeSectionType(line) {
  const u = line.trim().toUpperCase();
  for (const [h, type] of SECTION_HEADER_TYPES) {
    if (u === h.toUpperCase()) return type;
  }
  return null;
}

function isBulletLine(line) {
  const t = line.trim();
  return /^[•\-\*·]\s/.test(t) || /^[-–]\s/.test(t);
}

function stripBullet(line) {
  return line.trim().replace(/^[•\-\*·]\s*|^[-–]\s*/, "").trim();
}

/** Heuristic: new role header vs wrapped continuation of a bullet paragraph. */
function looksLikeJobTitleLine(line) {
  const t = line.trim();
  if (!t || isBulletLine(t)) return false;
  if (/^[a-z(]/.test(t)) return false;
  const hasDate = /(20\d{2}|Present|\bJan\b|\bFeb\b|\bMar\b|\bApr\b|\bMay\b|\bJun\b|\bJul\b|\bAug\b|\bSep\b|\bOct\b|\bNov\b|\bDec\b)/i.test(
    t,
  );
  const hasRole = /(engineer|developer|lead|architect|manager|intern|consultant|specialist|analyst)/i.test(t);
  return hasDate && hasRole;
}

/**
 * Job blocks: title line (often with dates), company line, then • bullets — repeated.
 * @param {string} body
 * @returns {{ title: string, company: string, period: string, bullets: string[] }[]}
 */
function parseExperienceJobs(body) {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  /** Legacy "EXPERIENCE" blocks are often only "- " bullets — job-block parser would yield empty titles. */
  if (lines.length > 0 && lines.every(isBulletLine)) {
    return [];
  }
  const jobs = [];
  /** @type {{ title: string, company: string, period: string, bullets: string[] } | null} */
  let job = null;

  const flush = () => {
    if (job && job.bullets.length > 0) {
      jobs.push({
        title: job.title,
        company: job.company,
        period: job.period,
        bullets: [...job.bullets],
      });
    }
    job = null;
  };

  const splitTitlePeriod = (titleLine) => {
    const re =
      /\s+((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4})\s*[–-]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4}|\d{4})|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[–-]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}|\d{4})|\d{4}\s*[–-]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4}|\d{4}))\s*$/i;
    const m = titleLine.match(re);
    if (m) {
      return { title: titleLine.slice(0, m.index).trim(), period: m[1].trim().replace(/\s+/g, " ") };
    }
    return { title: titleLine.trim(), period: "" };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBulletLine(line)) {
      if (!job) job = { title: "", company: "", period: "", bullets: [] };
      job.bullets.push(stripBullet(line));
      continue;
    }
    if (job && job.bullets.length > 0 && !looksLikeJobTitleLine(line)) {
      job.bullets[job.bullets.length - 1] = `${job.bullets[job.bullets.length - 1]} ${line.trim()}`.trim();
      continue;
    }
    if (job && job.bullets.length > 0) flush();
    if (!job) {
      const titleLine = line;
      const next = i + 1 < lines.length ? lines[i + 1] : "";
      const titleParts = splitTitlePeriod(titleLine);
      if (next && !isBulletLine(next)) {
        job = {
          title: titleParts.title,
          company: next,
          period: titleParts.period,
          bullets: [],
        };
        i++;
      } else {
        job = { title: titleParts.title, company: "", period: titleParts.period, bullets: [] };
      }
    } else if (job && job.bullets.length === 0 && !job.company) {
      job.company = line;
    } else if (job && job.bullets.length === 0) {
      job.title = `${job.title} ${line}`.trim();
    }
  }
  flush();
  return jobs;
}

function parseLegacyExperienceBullets(body) {
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("-")) out.push(t.replace(/^-\s*/, "").trim());
    else if (out.length) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  return out;
}

function joinSectionLines(arr) {
  return (arr || [])
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function extractLinksFromHeaderText(text) {
  const links = [];
  const join = String(text || "");
  const gh = join.match(/github\s*\(\s*([^)]+)\s*\)/i);
  if (gh) {
    const u = gh[1].trim().replace(/^@/, "");
    if (u) links.push({ text: "GitHub", url: `https://github.com/${u}` });
  }
  const li = join.match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s)\]]+/i);
  if (li) links.push({ text: "LinkedIn", url: li[0] });
  return links;
}

function parseFeaturedBlock(lines) {
  const arr = lines.map((l) => l.trim()).filter(Boolean);
  if (!arr.length) return null;
  const first = arr[0];
  const desc = arr.slice(1).join("\n").trim();
  const title = first.replace(/\s*·\s*Google Play\s*$/i, "").trim();
  return {
    title,
    url: "",
    url_label: "Google Play",
    description: desc || "—",
  };
}

function parseEducationBlock(lines) {
  const arr = lines.map((l) => l.trim()).filter(Boolean);
  if (!arr.length) return null;
  const degree_line = arr[0];
  const bullets = [];
  for (let i = 1; i < arr.length; i++) {
    const t = arr[i];
    bullets.push(isBulletLine(t) ? stripBullet(t) : t);
  }
  return { degree_line, bullets };
}

function toolingRowsFromLines(lines) {
  const text = joinSectionLines(lines);
  if (!text) return [];
  const rows = [];
  for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (m) rows.push({ label: m[1].trim(), value: m[2].trim() });
    else if (rows.length) rows[rows.length - 1].value += ` ${line}`;
  }
  return rows;
}

/**
 * Supports:
 * - Legacy blocks: TITLE / SUMMARY / SKILLS / EXPERIENCE (with "- " bullets).
 * - Narrative CV: preamble (name, subtitle, contact, links), PROFESSIONAL SUMMARY, CORE SKILLS,
 *   FEATURED PROJECT, PROFESSIONAL EXPERIENCE (job blocks + • bullets), TECHNICAL TOOLING, EDUCATION.
 * @returns {Record<string, unknown>}
 */
function parseResume(content) {
  const rawLines = content.split(/\r?\n/);
  /** @type {Record<string, string[]>} */
  const buckets = {
    preamble: [],
    title: [],
    summary: [],
    skills: [],
    experience: [],
    featured: [],
    tooling: [],
    education: [],
  };
  let section = "preamble";

  for (const line of rawLines) {
    const ht = resumeSectionType(line);
    if (ht) {
      section = ht;
      continue;
    }
    buckets[section].push(line);
  }

  const preambleJoined = joinSectionLines(buckets.preamble);
  const preambleLines = preambleJoined.split(/\n/).map((l) => l.trim()).filter(Boolean);

  let title = joinSectionLines(buckets.title).replace(/\s+/g, " ").trim();
  if (!title && preambleLines.length >= 1) {
    title =
      preambleLines.length >= 2
        ? `${preambleLines[0]} | ${preambleLines[1]}`
        : preambleLines[0];
  }

  const contact_line =
    preambleLines.length >= 3 ? preambleLines[2] : preambleLines.length === 2 && /@|\+?\d/.test(preambleLines[1])
      ? preambleLines[1]
      : "";

  const links = extractLinksFromHeaderText(preambleJoined);

  const summary = joinSectionLines(buckets.summary).trim();
  const skills = joinSectionLines(buckets.skills).trim();

  const experienceBody = joinSectionLines(buckets.experience);
  let jobs = parseExperienceJobs(experienceBody);
  let experience = jobs.flatMap((j) => j.bullets);
  if (jobs.length === 0 && experienceBody) {
    experience = parseLegacyExperienceBullets(experienceBody);
    if (experience.length) {
      jobs = [{ title: "Professional Experience", company: "", period: "", bullets: experience }];
    }
  }

  const featured_project = parseFeaturedBlock(buckets.featured);
  const technical_tooling = toolingRowsFromLines(buckets.tooling);
  const education = parseEducationBlock(buckets.education);

  return {
    title,
    contact_line,
    links,
    summary,
    skills,
    experience,
    jobs,
    featured_project,
    technical_tooling,
    education,
  };
}

function loadResume() {
  if (!fs.existsSync(resumePath)) {
    throw new Error(`Missing ${resumePath}. Create it (see repo data/resume.txt example).`);
  }
  return parseResume(fs.readFileSync(resumePath, "utf8"));
}

function loadDescription() {
  if (!fs.existsSync(descriptionPath)) {
    throw new Error(`Missing ${descriptionPath}. Create it with the job description.`);
  }
  return fs.readFileSync(descriptionPath, "utf8").trim();
}

function skillsList(skillsLine) {
  return skillsLine
    .split(/[,;]|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchedSkills(skillsLine, descLower, descSet) {
  return skillsList(skillsLine).filter((skill) => {
    const st = skill.toLowerCase();
    if (st.length < 2) return false;
    if (descLower.includes(st)) return true;
    for (const w of tokens(skill)) {
      if (descSet.has(w)) return true;
    }
    return false;
  });
}

function bulletScore(bullet, descSet) {
  let score = 0;
  for (const t of tokens(bullet)) {
    if (descSet.has(t)) score += 1;
  }
  return score;
}

function tailorExperience(experience, descSet) {
  return [...experience].sort((a, b) => bulletScore(b, descSet) - bulletScore(a, descSet));
}

function buildTailoringParagraph(description, skillsLine, experienceOrdered) {
  const descSet = descriptionTokenSet(description);
  const descLower = description.toLowerCase();
  const matched = matchedSkills(skillsLine, descLower, descSet);

  const topBullet = experienceOrdered[0];
  const topScore = topBullet ? bulletScore(topBullet, descSet) : 0;

  if (matched.length === 0 && topScore === 0) {
    return "Role fit: No strong keyword overlap yet between description.txt and your skills or bullets. Add shared terms (e.g. Swift, Firebase, REST) in both files so this section highlights them automatically.";
  }

  const parts = [];
  if (matched.length) {
    parts.push(
      `Emphasis for this opportunity: ${matched.join(", ")} — aligned with language in the job description.`,
    );
  }
  if (topScore > 0 && topBullet) {
    parts.push(
      "Experience bullets are ordered with the strongest textual match to the description first.",
    );
  }
  return parts.join(" ");
}

async function buildDocxBuffer(resume, tailoringParagraph, experienceOrdered) {
  const children = [
    new Paragraph({
      text: resume.title || "Resume",
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Summary: ", bold: true }),
        new TextRun(resume.summary || ""),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Role fit: ", bold: true }),
        new TextRun(tailoringParagraph),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Skills: ", bold: true }),
        new TextRun(resume.skills || ""),
      ],
    }),
    new Paragraph({
      text: "Experience",
      heading: HeadingLevel.HEADING_1,
    }),
    ...experienceOrdered.map(
      (line) =>
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun(line)],
        }),
    ),
  ];

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

function sofficeCandidatePaths() {
  const fromEnv =
    process.env.SOFFICE_PATH ||
    process.env.LIBREOFFICE_SOFFICE ||
    process.env.LIBRE_OFFICE_EXE ||
    "";
  const list = [];
  if (fromEnv) list.push(fromEnv);
  switch (process.platform) {
    case "darwin":
      list.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
      break;
    case "linux":
      list.push(
        "/usr/bin/libreoffice",
        "/usr/bin/soffice",
        "/snap/bin/libreoffice",
        "/opt/libreoffice/program/soffice",
      );
      break;
    case "win32": {
      const pf86 = process.env["PROGRAMFILES(X86)"] || "";
      const pf = process.env.PROGRAMFILES || "";
      list.push(
        path.join(pf86, "LibreOffice", "program", "soffice.exe"),
        path.join(pf, "LibreOffice", "program", "soffice.exe"),
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      );
      break;
    }
    default:
      break;
  }
  return list;
}

function findSoffice() {
  for (const p of sofficeCandidatePaths()) {
    if (!p) continue;
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function makeFreshUserInstallDir() {
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "docx-pdf-js-lo")
      : path.join(os.tmpdir(), "docx-pdf-js-lo");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "profile-"));
}

/** DOCX is opened in Writer; this filter is more reliable than plain `pdf`. */
const LO_WRITER_PDF_EXPORT = "pdf:writer_pdf_Export";

/**
 * @param {string | null} userInstallHref file URL or null
 * @param {"headless" | "invisible"} uiMode
 */
function buildLibreOfficeConvertArgv(userInstallHref, resolvedDocxAbs, outDirAbs, uiMode) {
  const prefix = userInstallHref ? [`-env:UserInstallation=${userInstallHref}`] : [];
  const ui =
    uiMode === "invisible"
      ? ["--invisible", "--norestore", "--nolockcheck", "--nologo", "--nofirststartwizard"]
      : ["--headless", "--norestore", "--nolockcheck", "--nologo", "--nofirststartwizard"];
  return [
    ...prefix,
    ...ui,
    "--convert-to",
    LO_WRITER_PDF_EXPORT,
    "--outdir",
    outDirAbs,
    resolvedDocxAbs,
  ];
}

function loExecEnv() {
  return {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
  };
}

/** Same as execFile for errors; used when a detached spawn may survive where execFile is SIGKILL'd. */
function spawnSofficeWait(soffice, argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(soffice, argv, {
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const cmd = `${soffice} ${argv.join(" ")}`;
      if (signal) {
        const err = new Error(`Command failed: ${cmd}`);
        err.signal = signal;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new Error(`Command failed: ${cmd} (exit ${code})`);
        err.code = code;
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function errorLooksLikeSigKill(err) {
  if (!err || typeof err !== "object") return false;
  if (err.signal === "SIGKILL") return true;
  if (err.cause && err.cause.signal === "SIGKILL") return true;
  if (String(err.message || "").includes("SIGKILL")) return true;
  return false;
}

function explainLoFailure(err) {
  const parts = [String(err.message || err)];
  if (err.stderr) parts.push(String(err.stderr).trim());
  if (err.stdout) parts.push(String(err.stdout).trim());
  const text = parts.filter(Boolean).join("\n");
  if (err.signal === "SIGKILL" || text.includes("SIGKILL")) {
    return (
      text +
      "\n\nLibreOffice was killed (SIGKILL). On macOS this often happens when `soffice` is launched from an integrated terminal.\n" +
      "Try one of:\n" +
      "  • Run `npm run build` in Terminal.app (outside the editor).\n" +
      "  • From Terminal.app: `npm run pdf` (runs bash → soffice, not Node).\n" +
      "  • Or `npm run build:docx` then File → Export as PDF in LibreOffice.\n" +
      "  • Open LibreOffice once from Finder so macOS permissions / first-run setup complete.\n" +
      "  • On Apple Silicon (M1/M2/M3): use the **Apple Silicon** LibreOffice build (Homebrew cask or “AArch64” from libreoffice.org); an Intel-only install can misbehave or be killed.\n"
    );
  }
  return text;
}

/**
 * Converts an on-disk .docx to .pdf in the same directory using LibreOffice.
 * Tries a few `soffice` flag/profile combinations (DOCX → Writer → PDF export).
 *
 * @param {string} docxPath absolute or relative path to the written .docx
 * @param {string} expectedPdfPath where the PDF should appear (LibreOffice uses input basename)
 */
async function convertWrittenDocxToPdf(docxPath, expectedPdfPath) {
  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      "Could not find LibreOffice (soffice). Set SOFFICE_PATH to the soffice binary, or install LibreOffice.\n" +
        "macOS example: brew install --cask libreoffice\n",
    );
  }

  const resolvedDocx = path.resolve(docxPath);
  const outDirAbs = path.resolve(path.dirname(docxPath));
  const expected = path.resolve(expectedPdfPath);
  const execOpts = { maxBuffer: 10 * 1024 * 1024, env: loExecEnv() };

  if (fs.existsSync(expected)) {
    fs.unlinkSync(expected);
  }

  /** @type {Array<{ label: string, run: () => Promise<void> }>} */
  const attempts = [];

  if (process.platform === "darwin") {
    attempts.push({
      label: "soffice (detached spawn, dedicated profile, headless)",
      run: async () => {
        const profileDir = makeFreshUserInstallDir();
        const href = pathToFileURL(profileDir).href;
        try {
          const argv = buildLibreOfficeConvertArgv(href, resolvedDocx, outDirAbs, "headless");
          await spawnSofficeWait(soffice, argv, loExecEnv());
        } finally {
          try {
            fs.rmSync(profileDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      },
    });
  }

  attempts.push({
    label: "soffice (dedicated profile, headless)",
    run: async () => {
      const profileDir = makeFreshUserInstallDir();
      const href = pathToFileURL(profileDir).href;
      try {
        await execFileAsync(
          soffice,
          buildLibreOfficeConvertArgv(href, resolvedDocx, outDirAbs, "headless"),
          execOpts,
        );
      } finally {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  });

  attempts.push({
    label: "soffice (no UserInstallation, headless)",
    run: async () => {
      await execFileAsync(
        soffice,
        buildLibreOfficeConvertArgv(null, resolvedDocx, outDirAbs, "headless"),
        execOpts,
      );
    },
  });

  attempts.push({
    label: "soffice (dedicated profile, invisible)",
    run: async () => {
      const profileDir = makeFreshUserInstallDir();
      const href = pathToFileURL(profileDir).href;
      try {
        await execFileAsync(
          soffice,
          buildLibreOfficeConvertArgv(href, resolvedDocx, outDirAbs, "invisible"),
          execOpts,
        );
      } finally {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  });

  let lastErr = null;
  for (const { label, run } of attempts) {
    try {
      await run();
      if (fs.existsSync(expected)) {
        return;
      }
      lastErr = new Error(
        `After "${label}", PDF was still missing at ${expected}.`,
      );
    } catch (err) {
      lastErr = err;
      if (fs.existsSync(expected)) {
        return;
      }
    }
  }

  const base = lastErr || new Error("LibreOffice conversion failed.");
  const msg = explainLoFailure(base);
  const out = new Error(msg);
  if (base && typeof base === "object" && "signal" in base && base.signal) {
    out.signal = base.signal;
  }
  out.cause = base;
  throw out;
}

function withHttps(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

/**
 * Styled CV only: replaces `contact_line` and `links` when `USE_FIXED_CONTACT=1`.
 * @param {Record<string, unknown> | null} profile
 */
function applyFixedContactFromEnv(profile) {
  if (!profile || process.env.USE_FIXED_CONTACT !== "1") return profile;
  const phone = (process.env.CONTACT_PHONE || "").trim();
  const portfolio = withHttps(process.env.CONTACT_PORTFOLIO || "");
  const linkedin = withHttps(process.env.CONTACT_LINKEDIN || "");
  const github = withHttps(process.env.CONTACT_GITHUB || "");
  const email = (process.env.CONTACT_EMAIL || "").trim();
  const missing = [];
  if (!phone) missing.push("CONTACT_PHONE");
  if (!portfolio) missing.push("CONTACT_PORTFOLIO");
  if (!linkedin) missing.push("CONTACT_LINKEDIN");
  if (!github) missing.push("CONTACT_GITHUB");
  if (!email) missing.push("CONTACT_EMAIL");
  if (missing.length) {
    throw new Error(
      `USE_FIXED_CONTACT=1 requires these in .env: ${missing.join(", ")} (see .env.example).`,
    );
  }
  profile.contact_line = `${phone} · ${email}`;
  profile.links = [
    { text: "Portfolio", url: portfolio },
    { text: "LinkedIn", url: linkedin },
    { text: "GitHub", url: github },
  ];
  return profile;
}

/**
 * Styled CV only: sets Featured Project Play Store URL (and optional title/description) when
 * `USE_FIXED_FEATURED_PROJECT=1`. Merges onto existing `profile.featured_project` from resume / AI.
 * @param {Record<string, unknown> | null} profile
 */
function applyFixedFeaturedProjectFromEnv(profile) {
  if (!profile || process.env.USE_FIXED_FEATURED_PROJECT !== "1") return profile;
  const rawUrl = (process.env.FEATURED_PROJECT_URL || process.env.MEGAPLUG_PLAY_URL || "").trim();
  if (!rawUrl) {
    throw new Error(
      "USE_FIXED_FEATURED_PROJECT=1 requires FEATURED_PROJECT_URL (or MEGAPLUG_PLAY_URL) in .env (see .env.example).",
    );
  }
  const url = withHttps(rawUrl);
  const urlLabel = (process.env.FEATURED_PROJECT_URL_LABEL || "Google Play").trim() || "Google Play";
  const titleOverride = (process.env.FEATURED_PROJECT_TITLE || "").trim();
  const descOverride = (process.env.FEATURED_PROJECT_DESCRIPTION || "").trim();

  const existing =
    profile.featured_project && typeof profile.featured_project === "object"
      ? { ...profile.featured_project }
      : {};
  const title =
    titleOverride ||
    String(existing.title || "").trim() ||
    "MegaPlug — EV Charging Management Platform";
  const description =
    descOverride || String(existing.description || "").trim() || "—";

  profile.featured_project = {
    ...existing,
    title,
    url,
    url_label: urlLabel,
    description,
  };
  return profile;
}

async function main() {
  loadRootEnvFile();
  ensureDir(outDir);

  const description = loadDescription();
  let resume = null;
  let experienceOrdered = [];
  let tailoringParagraph = "";
  /** @type {Record<string, unknown> | null} */
  let profile = null;

  if (process.env.USE_AI === "1") {
    if (!fs.existsSync(resumePath)) {
      throw new Error(`Missing ${resumePath}.`);
    }
    const resumeText = fs.readFileSync(resumePath, "utf8");
    console.log("USE_AI=1: generating tailored CV fields via LLM…");
    const { profile: aiProfile } = await generateTailoredCvWithAi({
      resumeText,
      jobDescription: description,
    });
    profile = aiProfile;
  } else {
    resume = loadResume();
    const descSet = descriptionTokenSet(description);
    experienceOrdered = tailorExperience(resume.experience, descSet);
    tailoringParagraph = buildTailoringParagraph(
      description,
      resume.skills,
      experienceOrdered,
    );
    profile = profileFromParsedResume(resume, tailoringParagraph);
  }

  applyFixedContactFromEnv(profile);
  applyFixedFeaturedProjectFromEnv(profile);

  const docxPath = path.join(outDir, `${outputBase}.docx`);
  const pdfPath = path.join(outDir, `${outputBase}.pdf`);

  const useSimpleLayout = process.env.CV_LAYOUT === "simple";
  let docxBuf;
  if (useSimpleLayout && process.env.USE_AI !== "1" && resume) {
    docxBuf = await buildDocxBuffer(resume, tailoringParagraph, experienceOrdered);
  } else {
    if (useSimpleLayout && process.env.USE_AI === "1") {
      console.warn("CV_LAYOUT=simple is ignored when USE_AI=1; using styled CV template.");
    }
    docxBuf = await createStyledCvDocumentBuffer(profile);
  }
  fs.writeFileSync(docxPath, docxBuf);
  console.log(`Wrote DOCX: ${docxPath}`);

  if (process.env.SKIP_PDF === "1") {
    console.log("SKIP_PDF=1: skipping LibreOffice PDF step.");
    return;
  }

  try {
    await convertWrittenDocxToPdf(docxPath, pdfPath);
  } catch (err) {
    const sigKill = errorLooksLikeSigKill(err);
    const strict = process.env.STRICT_BUILD === "1";

    if (sigKill && !strict) {
      console.error(
        "\nPDF step was killed (SIGKILL) from this environment — your DOCX is still valid.\n" +
          `  DOCX: ${docxPath}\n` +
          "  For PDF, open Terminal.app in the project folder and run: npm run pdf\n" +
          "  (Or: npm run build:docx to skip trying PDF here.)\n" +
          "  Set STRICT_BUILD=1 if you need `npm run build` to exit with an error when PDF fails.\n",
      );
      return;
    }

    console.error(
      "\nPDF conversion failed after writing the DOCX. Install LibreOffice or set SOFFICE_PATH.\n" +
        "If `soffice` is SIGKILL’d from this terminal, run `npm run pdf` in Terminal.app, or `npm run build:docx` then `npm run pdf`.\n" +
        "Example (macOS): brew install --cask libreoffice\n",
    );
    throw err;
  }

  console.log(`Wrote PDF:  ${pdfPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
