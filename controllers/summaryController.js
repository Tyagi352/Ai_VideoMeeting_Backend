import Summary from "../models/Summary.js";
import fetch from "node-fetch";

/* ================================================================
   CONSTANTS
================================================================ */
// Determines which LLM provider to use based on available keys.
// Priority: Claude (Anthropic) → OpenAI
// Keys are read dynamically at runtime to resolve ESM module hoisting issues.


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
   STEP 0 — AssemblyAI: Upload audio buffer
================================================================ */
const uploadAudioToAssemblyAI = async (audioBuffer) => {
  const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.replace(/^["']|["']$/g, "") : "";
  console.log("[AssemblyAI debug] Key:", ASSEMBLYAI_API_KEY ? `${ASSEMBLYAI_API_KEY.slice(0, 4)}...${ASSEMBLYAI_API_KEY.slice(-4)} (length: ${ASSEMBLYAI_API_KEY.length})` : "MISSING");
  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: ASSEMBLYAI_API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: audioBuffer,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("AssemblyAI upload failed: " + txt);
  }

  const data = await res.json();
  return data.upload_url;
};

/* ================================================================
   STEP 0 (cont.) — AssemblyAI: Transcribe with speaker labels only.
   No summarization flag — we do that ourselves with the LLM pipeline.
================================================================ */
const transcribeAudio = async (audioUrl) => {
  const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.replace(/^["']|["']$/g, "") : "";
  // Submit transcription job (raw transcript + speaker diarization only)
  const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: ASSEMBLYAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true, // diarization: labels each utterance with a speaker
      // NOTE: summarization / summary_model / summary_type intentionally removed
    }),
  });

  if (!submitRes.ok) {
    const txt = await submitRes.text();
    throw new Error("AssemblyAI transcription submission failed: " + txt);
  }

  let transcript = await submitRes.json();

  // Poll until done (queued → processing → completed | error)
  while (["queued", "processing"].includes(transcript.status)) {
    await sleep(2000);
    const pollRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcript.id}`,
      { headers: { Authorization: ASSEMBLYAI_API_KEY } }
    );
    transcript = await pollRes.json();
  }

  if (transcript.status === "error") {
    throw new Error("AssemblyAI transcription error: " + transcript.error);
  }

  // Build a speaker-labeled transcript string (e.g. "Speaker A: Hello ...")
  let labeledTranscript = transcript.text || "";
  if (transcript.utterances && transcript.utterances.length > 0) {
    labeledTranscript = transcript.utterances
      .map((u) => `Speaker ${u.speaker}: ${u.text}`)
      .join("\n");
  }

  return {
    rawText: transcript.text || "",
    labeledTranscript,           // used for LLM pipeline
    utterances: transcript.utterances || [], // raw speaker-diarized segments
  };
};

/* ================================================================
   LLM HELPER — Single unified call function.
   Supports Anthropic Claude (Messages API) and OpenAI Chat.
================================================================ */
// const callLLM = async (systemPrompt, userMessage) => {
//   const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/^["']|["']$/g, "") : "";

//   if (!GEMINI_API_KEY) {
//     throw new Error(
//       "No Gemini API key found. Add GEMINI_API_KEY to your .env file."
//     );
//   }

//   // ── Gemini 2.5 Flash API ──
//   const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

//   const res = await fetch(url, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "x-goog-api-key": GEMINI_API_KEY,
//     },
//     body: JSON.stringify({
//       contents: [{
//         parts: [{ text: userMessage }]
//       }],
//       systemInstruction: {
//         parts: [{ text: systemPrompt }]
//       },
//       generationConfig: {
//         responseMimeType: "application/json"
//       }
//     }),
//   });

//   if (!res.ok) {
//     const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
//     throw new Error("Gemini API error: " + (err?.error?.message || err?.message || res.statusText));
//   }

//   const data = await res.json();
//   return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
// };


const callLLM = async (systemPrompt, userMessage, keyIndex = 1) => {
  const keys = {
    1: process.env.GEMINI_API_KEY_1,
    2: process.env.GEMINI_API_KEY_2,
    3: process.env.GEMINI_API_KEY_3,
  };

  const clean = (k) => (k ? k.replace(/^["']|["']$/g, "") : "");

  // Try the requested key first, then fall back to any other available key
  let GEMINI_API_KEY = clean(keys[keyIndex]);
  let usedIndex = keyIndex;

  if (!GEMINI_API_KEY) {
    for (const [idx, val] of Object.entries(keys)) {
      if (clean(val)) {
        GEMINI_API_KEY = clean(val);
        usedIndex = idx;
        break;
      }
    }
  }

  if (!GEMINI_API_KEY) {
    throw new Error(
      "No Gemini API key found. Add GEMINI_API_KEY_1, GEMINI_API_KEY_2, or GEMINI_API_KEY_3 to your .env file."
    );
  }

  console.log(
    `[Gemini debug] Using key ${usedIndex}:`,
    `${GEMINI_API_KEY.slice(0, 4)}...${GEMINI_API_KEY.slice(-4)}`
  );

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: userMessage }]
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 4096
      }
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error("Gemini API error: " + (err?.error?.message || err?.message || res.statusText));
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
};




/* ================================================================
   SAFE JSON PARSER — extracts JSON even when the LLM wraps it in
   markdown code fences (```json ... ```)
================================================================ */
const safeParseJSON = (text, fallback) => {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn("JSON parse failed, returning fallback. Raw text:", text.slice(0, 200));
    return fallback;
  }
};

/* ================================================================
   PIPELINE STEP 1 — Topic / Segment Extraction
   Input:  labeled transcript string
   Output: [{ title: string, excerpt: string }]
================================================================ */
const extractTopics = async (labeledTranscript) => {
  const system = `You are an expert meeting analyst. Your job is to break a meeting transcript into clear topic segments.
Return ONLY a valid JSON array. No markdown, no explanation — just the raw JSON.
Each element must have exactly these keys:
  "title"   — a short descriptive title (3–6 words) for the topic
  "excerpt" — the relevant portion of the transcript for this topic (verbatim or lightly paraphrased)

Example output format:
[
  { "title": "Q2 Revenue Review", "excerpt": "Speaker A: Our revenue this quarter..." },
  { "title": "Product Roadmap Discussion", "excerpt": "Speaker B: We need to ship..." }
]`;

  const user = `Here is the meeting transcript:\n\n${labeledTranscript}\n\nIdentify and extract the main topics discussed.`;

  const raw = await callLLM(system, user, 1);
  return safeParseJSON(raw, [{ title: "Full Meeting", excerpt: labeledTranscript.slice(0, 500) }]);
};

/* ================================================================
   PIPELINE STEP 2 — Action Item Extraction
   Input:  topics array from Step 1, original labeled transcript (for speaker context)
   Output: [{ task: string, context: string, speaker: string }]
================================================================ */
const extractActionItems = async (topics, labeledTranscript) => {
  const topicsText = topics.map((t, i) => `Topic ${i + 1}: ${t.title}\n${t.excerpt}`).join("\n\n");

  const system = `You are an expert meeting analyst focused on identifying actionable outcomes.
Given meeting topics and a transcript, extract all action items, decisions, and follow-ups.
Return ONLY a valid JSON array. No markdown, no explanation — just the raw JSON.
Each element must have exactly these keys:
  "task"    — a clear, concise description of what needs to be done
  "context" — the brief context or reason behind this task
  "speaker" — the speaker responsible (e.g. "Speaker A"), or "Team" if unclear or shared

If there are no action items, return an empty array: []`;

  const user = `Meeting Topics:\n${topicsText}\n\nFull Transcript (for speaker context):\n${labeledTranscript}\n\nExtract all action items, decisions, and follow-ups.`;

  const raw = await callLLM(system, user, 2);
  return safeParseJSON(raw, []);
};


// Santinization Function

const sanitizeActionItems = (items, fallbackItems) => {
  if (!Array.isArray(items)) return fallbackItems || [];

  return items.map((item) => {
    if (item && typeof item === "object") {
      return {
        task: String(item.task || item.description || "").trim(),
        context: String(item.context || item.reason || "").trim(),
        speaker: String(item.speaker || "Team").trim(),
      };
    }

    if (typeof item === "string") {
      let speaker = "Team";
      let task = item;
      let context = "";

      const speakerMatch = item.match(/^\[([^\]]+)\]\s*(.*)/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        task = speakerMatch[2].trim();
      }

      const contextMatch = task.match(/(.*)\s*\((?:context|Context):\s*(.*)\)/i);
      if (contextMatch) {
        task = contextMatch[1].trim();
        context = contextMatch[2].trim();
      }

      return { task, context, speaker };
    }

    return { task: "Action item details not parseable", context: "", speaker: "Team" };
  });
};
/* ================================================================
   PIPELINE STEP 3 — Final Structured Summary
   Input:  topics (Step 1), actionItems (Step 2), rawTranscript
   Output: { summary: string, keyPoints: string[], actionItems: [...] }
================================================================ */
const buildFinalSummary = async (topics, actionItems, rawText) => {
  const topicsText = topics.map((t) => `- ${t.title}: ${t.excerpt.slice(0, 150)}`).join("\n");
  const actionsText = actionItems.length
    ? actionItems.map((a) => `- [${a.speaker}] ${a.task} (Context: ${a.context})`).join("\n")
    : "No specific action items identified.";

  const system = `You are a professional meeting summarizer. Your output must be ONLY a valid JSON object.
No markdown, no explanation — just the raw JSON.
The JSON must have exactly these keys:
  "summary"     — a concise 3–4 sentence paragraph summarizing the entire meeting
  "keyPoints"   — a JSON array of strings, each being one key takeaway (5–8 bullets max)
  "actionItems" — pass through the action items array you are given (do not modify them)`;

  const user = `Topics discussed:\n${topicsText}\n\nAction items:\n${actionsText}\n\nOriginal transcript (first 800 chars for context):\n${rawText.slice(0, 800)}\n\nGenerate the final structured meeting summary.`;

  const raw = await callLLM(system, user, 3);
  const parsed = safeParseJSON(raw, null);

  if (parsed && parsed.summary) {
    // Ensure actionItems are carried through correctly
    return {
      summary: parsed.summary,
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      actionItems: sanitizeActionItems(parsed.actionItems, actionItems),
    };
  }

  // Fallback if LLM returns unparseable response
  return {
    summary: "Meeting summary could not be fully generated.",
    keyPoints: topics.map((t) => t.title),
    actionItems: actionItems,
  };
};

/* ================================================================
   CREATE SUMMARY — Main controller (POST /api/summary)
================================================================ */
export const createSummary = async (req, res) => {
  // ── Guards ──
  if (!req.file) {
    return res.status(400).json({ message: "No audio file uploaded" });
  }
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const pipelineResult = {
    transcript: "",
    summary: "",
    keyPoints: [],
    actionItems: [],
    partial: false,   // set true if any step partially failed
    partialReason: null,
  };

  try {
    /* ── STEP 0A: Upload audio to AssemblyAI ── */
    console.log("[Pipeline] Uploading audio to AssemblyAI...");
    const audioUploadUrl = await uploadAudioToAssemblyAI(req.file.buffer);

    /* ── STEP 0B: Transcribe (raw text + speaker labels) ── */
    console.log("[Pipeline] Transcribing audio...");
    const { rawText, labeledTranscript } = await transcribeAudio(audioUploadUrl);
    pipelineResult.transcript = rawText;

    if (!rawText || rawText.trim().length === 0) {
      // No speech detected — save minimal record and return
      console.warn("[Pipeline] Empty transcript — skipping LLM steps.");
      pipelineResult.summary = "No speech was detected in the recording.";
      pipelineResult.partial = true;
      pipelineResult.partialReason = "Empty transcript";
    } else {
      /* ── STEP 1: Topic Extraction ── */
      let topics = [];
      try {
        console.log("[Pipeline] Step 1 — Extracting topics...");
        topics = await extractTopics(labeledTranscript);
        console.log(`[Pipeline] Step 1 complete — ${topics.length} topics found.`);
      } catch (err) {
        console.error("[Pipeline] Step 1 failed:", err.message);
        pipelineResult.partial = true;
        pipelineResult.partialReason = "Topic extraction failed: " + err.message;
        // Provide a single fallback topic to allow Steps 2 & 3 to still run
        topics = [{ title: "Full Meeting", excerpt: labeledTranscript.slice(0, 1000) }];
      }

      /* ── STEP 2: Action Item Extraction ── */
      let actionItems = [];
      try {
        console.log("[Pipeline] Step 2 — Extracting action items...");
        actionItems = await extractActionItems(topics, labeledTranscript);
        pipelineResult.actionItems = actionItems;
        console.log(`[Pipeline] Step 2 complete — ${actionItems.length} action items found.`);
      } catch (err) {
        console.error("[Pipeline] Step 2 failed:", err.message);
        pipelineResult.partial = true;
        pipelineResult.partialReason = (pipelineResult.partialReason || "") + " | Action item extraction failed: " + err.message;
        // Continue with empty action items
      }

      /* ── STEP 3: Final Structured Summary ── */
      try {
        console.log("[Pipeline] Step 3 — Building final structured summary...");
        const finalResult = await buildFinalSummary(topics, actionItems, rawText);
        pipelineResult.summary = finalResult.summary;
        pipelineResult.keyPoints = finalResult.keyPoints;
        pipelineResult.actionItems = finalResult.actionItems; // may be enriched by Step 3
        console.log("[Pipeline] Step 3 complete.");
      } catch (err) {
        console.error("[Pipeline] Step 3 failed:", err.message);
        pipelineResult.partial = true;
        pipelineResult.partialReason = (pipelineResult.partialReason || "") + " | Final summary failed: " + err.message;
        // Fallback: use topic titles as key points
        pipelineResult.summary = "Automatic summary generation encountered an error.";
        pipelineResult.keyPoints = topics.map((t) => t.title);
      }
    }

    /* ── Save to MongoDB ── */
    const record = new Summary({
      roomId: req.body.roomId || "unknown",
      participants: [req.user._id],
      transcript: pipelineResult.transcript,
      summary: pipelineResult.summary,
      keyPoints: pipelineResult.keyPoints,
      actionItems: pipelineResult.actionItems,
      audioUrl: "in-memory",
      partial: pipelineResult.partial,
    });

    await record.save();
    console.log("[Pipeline] Saved summary to DB:", record._id);

    return res.json({
      id: record._id,
      transcript: record.transcript,
      summary: record.summary,
      keyPoints: record.keyPoints,
      actionItems: record.actionItems,
      partial: record.partial,
      partialReason: pipelineResult.partialReason,
    });

  } catch (err) {
    // Catastrophic failure (e.g. AssemblyAI upload failed entirely)
    console.error("[Pipeline] Fatal error:", err.message);
    return res.status(500).json({
      message: "Failed to process audio: " + err.message,
      partial: true,
      transcript: pipelineResult.transcript,
      summary: pipelineResult.summary || "",
      keyPoints: pipelineResult.keyPoints || [],
      actionItems: pipelineResult.actionItems || [],
    });
  }
};

/* ================================================================
   GET SUMMARIES — GET /api/summary
================================================================ */
export const getSummaries = async (req, res) => {
  try {
    const data = await Summary.find({
      participants: req.user._id,
    }).sort({ createdAt: -1 });

    res.json(data);
  } catch (err) {
    console.error("[getSummaries]", err.message);
    res.status(500).json({ message: "Failed to fetch summaries" });
  }
};

/* ================================================================
   DELETE SUMMARY — DELETE /api/summary/:id
================================================================ */
export const deleteSummary = async (req, res) => {
  try {
    const record = await Summary.findById(req.params.id);

    if (!record) {
      return res.status(404).json({ message: "Summary not found" });
    }
    if (!record.participants.map(String).includes(String(req.user._id))) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await record.deleteOne();
    res.json({ message: "Summary deleted" });
  } catch (err) {
    console.error("[deleteSummary]", err.message);
    res.status(500).json({ message: "Delete failed" });
  }
};
