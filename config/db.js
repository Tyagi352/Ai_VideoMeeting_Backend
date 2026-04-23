import mongoose from "mongoose";

let isConnected = false;

const connectDB = async () => {
  if (isConnected) {
    console.log("Using existing MongoDB connection");
    return;
  }

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is missing in environment variables");
    throw new Error("MONGO_URI not defined");
  }

  try {
    const db = await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    isConnected = db.connections[0].readyState === 1;
    console.log("MongoDB Connected Successfully");
  } catch (err) {
    console.error("MongoDB Connection Error:", err.message);
    throw err; // Re-throw to be handled by the caller
  }
};

export default connectDB;