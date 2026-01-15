import mongoose from 'mongoose';

const summarySchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  transcript: { type: String },
  summary: { type: String },
  audioUrl: { type: String },
}, { timestamps: true });

export default mongoose.model('Summary', summarySchema);
