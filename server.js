import express from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 1024) * 1024 * 1024 },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = process.env.PORT || 3000;
const groqApiKey = process.env.GROQ_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
// How big a file can be before we chunk it (Groq limit is ~25MB but duration matters more)
const DIRECT_MAX_MB = parseInt(process.env.DIRECT_TRANSCRIBE_MAX_MB) || 20;
const CHUNK_MINUTES = parseInt(process.env.TRANSCRIBE_CHUNK_MINUTES) || 8;

if (!groqApiKey) console.error("Missing GROQ_API_KEY in environment.");
if (!anthropicApiKey) console.error("Missing ANTHROPIC_API_KEY in environment.");

// Groq hosts Whisper via an OpenAI-compatible API
// Use a placeholder so the constructor doesn't throw at startup when key is missing
const groq = new OpenAI({
  apiKey: groqApiKey || "not-set",
  baseURL: "https://api.groq.com/openai/v1",
});

const anthropic = new Anthropic({ apiKey: anthropicApiKey || "not-set" });

const localeToLanguageCode = {
  auto: undefined,
  en: "en",
  "en-IN": "en",
  ta: "ta",
  tanglish: "ta",
  hi: "hi",
  kn: "kn",
  ml: "ml",
  te: "te",
  mr: "mr",
  gu: "gu",
  bn: "bn",
  pa: "pa",
  or: "or",
  as: "as",
};

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function transcribeBuffer(buffer, filename, language, prompt) {
  const result = await groq.audio.transcriptions.create({
    model: "whisper-large-v3-turbo",
    file: await toFile(buffer, filename),
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
  });
  return result.text || "";
}

async function splitToWavChunks(inputPath, tmpDir, chunkMinutes) {
  const chunkSeconds = chunkMinutes * 60;
  const pattern = path.join(tmpDir, "chunk_%03d.wav");
  await execAsync(
    `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f segment -segment_time ${chunkSeconds} "${pattern}" 2>&1`
  );
  // Collect chunk files in order
  const { stdout } = await execAsync(`ls "${tmpDir}"/chunk_*.wav 2>/dev/null || true`);
  return stdout.trim().split("\n").filter(Boolean).sort();
}

async function transcribeWithChunking(buffer, originalname, language, prompt) {
  const tmpDir = path.join(tmpdir(), `transcribe-${randomBytes(8).toString("hex")}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, originalname || "audio.bin");
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(inputPath, buffer));

  try {
    const chunkPaths = await splitToWavChunks(inputPath, tmpDir, CHUNK_MINUTES);
    if (chunkPaths.length === 0) throw new Error("ffmpeg produced no chunks");

    const parts = await Promise.all(
      chunkPaths.map(async (p) => {
        const buf = await readFile(p);
        return transcribeBuffer(buf, path.basename(p), language, prompt);
      })
    );

    return parts.join(" ").trim();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!groqApiKey) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY." });
  }
  if (!anthropicApiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Audio file is required." });
  }

  try {
    const selectedLanguage = req.body.language || "auto";
    const language = localeToLanguageCode[selectedLanguage] || undefined;
    const whisperPrompt =
      selectedLanguage === "tanglish"
        ? "This audio may include code-switched Tamil and English (Tanglish). Preserve both naturally."
        : undefined;

    const fileSizeMB = req.file.buffer.length / (1024 * 1024);

    let rawTranscript;
    if (fileSizeMB <= DIRECT_MAX_MB) {
      // Small enough — transcribe directly
      rawTranscript = await transcribeBuffer(
        req.file.buffer,
        req.file.originalname || "audio.webm",
        language,
        whisperPrompt
      );
    } else {
      // Large file — split into chunks with ffmpeg
      rawTranscript = await transcribeWithChunking(
        req.file.buffer,
        req.file.originalname || "audio.bin",
        language,
        whisperPrompt
      );
    }

    // Format with Anthropic Claude
    const formatted = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system:
        "You format transcripts into detailed, well-structured Markdown without losing content fidelity.",
      messages: [
        {
          role: "user",
          content:
            "Convert this transcript into detailed Markdown. " +
            "Output must be factual and based only on the transcript. " +
            "Use these sections exactly: " +
            "# Transcript, ## Metadata, ## Structured Transcript, ## Key Topics Mentioned, ## Clarifications Needed. " +
            "In Metadata include language and a note that speaker labels are inferred when uncertain. " +
            "In Structured Transcript, break into logical turns as bullet points; use **Speaker 1**, **Speaker 2** only when a speaker change is obvious, otherwise use **Speaker (unidentified)**. " +
            "Do not invent timestamps or names. " +
            `Language preference: ${selectedLanguage}. ` +
            `Raw transcript:\n${rawTranscript}`,
        },
      ],
    });

    const formattedText = formatted.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return res.json({ transcript: formattedText || rawTranscript });
  } catch (error) {
    console.error("Transcribe error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to transcribe audio.",
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  if (!anthropicApiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  const transcript = req.body?.transcript?.trim();
  const language = req.body?.language || "auto";

  if (!transcript) {
    return res.status(400).json({ error: "Transcript is required." });
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      system:
        "You produce detailed, professional Markdown meeting documentation for business users. Always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content:
            `Language preference: ${language}. ` +
            "Return valid JSON only with keys: summary, minutes. " +
            "Both summary and minutes must be fully formatted Markdown and highly detailed. " +
            "summary format requirements: " +
            "# Meeting Summary, ## Executive Overview, ## Business Context, ## Detailed Highlights, ## Risks and Dependencies, ## Next-step Focus. " +
            "Use rich bullet points with concrete details and references to transcript content. " +
            "minutes format requirements: " +
            "# Meeting Minutes, ## Meeting Context, ## Agenda Covered, ## Detailed Discussion Log, ## Decisions Made, ## Action Items, ## Open Questions, ## Follow-up Plan. " +
            "For Action Items include a Markdown table with columns: Item, Owner, Due Date, Priority, Status. " +
            "If owner or due date is missing, write Unknown. " +
            "Do not hallucinate facts; if missing, explicitly state Unknown or Not specified. " +
            `Transcript:\n${transcript}`,
        },
      ],
    });

    const outputText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = JSON.parse(outputText || "{}");
    return res.json({
      summary: parsed.summary || "No summary generated.",
      minutes: parsed.minutes || "No minutes generated.",
    });
  } catch (error) {
    console.error("Analyze error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to generate summary and minutes.",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
