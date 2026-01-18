import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import summaryRoutes from "./routes/summary.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

/* ========================
   ALLOWED ORIGINS
======================== */
const allowedOrigins = [
<<<<<<< HEAD
  // "https://ai-videomeeting-frontend-1.onrender.com",
  "http://localhost:5173",
  "http://localhost:5174"
=======
  "https://ai-videomeeting-frontend-1.onrender.com",
  "http://localhost:5173"
>>>>>>> 2a4691c5cb9ebf75c85f8a7fb7a7f2de51e6522e
];

/* ========================
   CORS (ONLY ONCE)
======================== */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS not allowed"));
      }
    },
    credentials: true
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ========================
   DB CONNECT (ONLY ONCE)
======================== */
connectDB()
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => {
    console.error("DB connection failed", err);
    process.exit(1);
  });

/* ========================
   ROUTES
======================== */
app.use("/api/auth", authRoutes);
app.use("/api/summary", summaryRoutes);

/* ========================
   SOCKET.IO
======================== */
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const userSocketMap = new Map();

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    userSocketMap.set(socket.id, userId);
    socket.join(roomId);

    const room = io.sockets.adapter.rooms.get(roomId) || new Set();
    const others = [...room].filter((id) => id !== socket.id);

    socket.emit(
      "all-users",
      others.map((id) => ({
        socketId: id,
        userId: userSocketMap.get(id)
      }))
    );

    socket.to(roomId).emit("user-connected", socket.id);
  });

  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", {
      from: data.from,
      signal: data.signal
    });
  });

  socket.on("disconnect", () => {
    userSocketMap.delete(socket.id);
    console.log("Socket disconnected:", socket.id);
  });
});

/* ========================
   START SERVER
======================== */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
