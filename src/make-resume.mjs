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
 *   ./data/resume.txt       — sections: TITLE, SUMMARY, SKILLS, EXPERIENCE (bullets with leading "- ")
 *   ./data/description.txt — job description; used to emphasize matching skills and reorder bullets
 *
 * Outputs:
 *   ./out/michael_samuel_cv.docx
 *   ./out/michael_samuel_cv.pdf
 *
 * CV layout: default is **styled** (Arial, accent rules, job blocks, numbered bullets like the reference template).
 * Set CV_LAYOUT=simple for the older minimal headings + bullets layout.
 *
 * AI tailoring (optional), USE_AI=1:
 *   • CURSOR_API_KEY — Cursor Cloud Agents (`https://api.cursor.com/v0/agents`). Set CURSOR_REPOSITORY
 *     to https://github.com/owner/repo if origin is not GitHub; optional CURSOR_REF, CURSOR_MODEL.
 *   • OPENAI_API_KEY / ANTHROPIC_API_KEY — direct provider APIs (optional OPENAI_MODEL, etc.).
 *   • AI_PROVIDER=cursor|openai|anthropic when more than one credential is set.
 *   • Optional: create `.env` in the project root with those variables — it is loaded automatically
 *     (shell exports still win if the variable is already set).
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

/**
 * @returns {{ title: string, summary: string, skills: string, experience: string[] }}
 */
function parseResume(content) {
  const blocks = content.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const data = {
    title: "",
    summary: "",
    skills: "",
    experience: [],
  };

  for (const block of blocks) {
    const lines = block.split("\n");
    const section = lines[0].trim().toUpperCase();
    const body = lines.slice(1).join("\n").trim();

    if (section === "TITLE") data.title = body;
    else if (section === "SUMMARY") data.summary = body;
    else if (section === "SKILLS") data.skills = body.replace(/\s+/g, " ");
    else if (section === "EXPERIENCE") {
      for (const line of body.split("\n")) {
        const t = line.trim();
        if (t.startsWith("-")) data.experience.push(t.replace(/^-\s*/, "").trim());
        else if (t) data.experience.push(t);
      }
    }
  }

  return data;
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
