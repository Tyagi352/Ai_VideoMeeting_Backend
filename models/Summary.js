import mongoose from 'mongoose';

/* ----------------------------------------------------------------
   Action Item sub-schema
   Each item produced by the LLM pipeline (Step 2) looks like:
   { task: "...", context: "...", speaker: "Speaker A" }
---------------------------------------------------------------- */
const actionItemSchema = new mongoose.Schema({
  task:    { type: String, default: "" },
  context: { type: String, default: "" },
  speaker: { type: String, default: "Unknown" },
}, { _id: false }); // no separate _id needed for embedded docs

/* ----------------------------------------------------------------
   Main Summary schema
---------------------------------------------------------------- */
const summarySchema = new mongoose.Schema({
  roomId:       { type: String, required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Raw transcript text from AssemblyAI
  transcript:  { type: String, default: "" },

  // Short 3–4 sentence paragraph from LLM Step 3
  summary:     { type: String, default: "" },

  // Key takeaway bullet points (array of strings) from LLM Step 3
  keyPoints:   [{ type: String }],

  // Structured action items from LLM Steps 2 & 3
  actionItems: [actionItemSchema],

  // URL/reference to recorded audio (or "in-memory" for serverless)
  audioUrl:    { type: String, default: "" },

  // True if the LLM pipeline only partially completed
  partial:     { type: Boolean, default: false },

}, { timestamps: true });

export default mongoose.model('Summary', summarySchema);
