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
  "http://localhost:5173",
  "http://localhost:5174",
  "https://ai-video-meeting-frontend.vercel.app",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Always set these headers for every request
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  
  next();
});


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ========================
   DB CONNECT
 ======================== */
connectDB()
  .then(() => console.log("Database initialized"))
  .catch((err) => {
    console.error("Critical DB initialization failure:", err.message);
    // On Vercel, we don't process.exit(1) as it kills the instance.
    // Instead, individual routes will fail if they need DB access.
  });

/* ========================
   ROUTES
 ======================== */
app.get("/", (req, res) => {
  res.json({ message: "AI Video Meeting API is running" });
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.use("/api/auth", authRoutes);
app.use("/api/summary", summaryRoutes);

/* ========================
   SOCKET.IO
======================== */
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
        callback(null, true);
      } else {
        callback(new Error("CORS not allowed"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});


const userSocketMap = new Map();
const roomHostMap = new Map(); // Track host (first user) in each room
const roomWaitingMap = new Map(); // Track waiting participants per room
const userStatusMap = new Map(); // Track user status: 'admitted' or 'waiting'

const socketRoomMap = new Map();

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    userSocketMap.set(socket.id, userId);
    socketRoomMap.set(socket.id, roomId);
    socket.join(roomId);

    const room = io.sockets.adapter.rooms.get(roomId) || new Set();
    const others = [...room].filter((id) => id !== socket.id);

    // Determine if this is the first user (host)
    if (!roomHostMap.has(roomId)) {
      roomHostMap.set(roomId, socket.id);
      userStatusMap.set(socket.id, 'admitted');
      console.log(`User ${socket.id} is host of room ${roomId}`);
    } else {
      // Non-host user joins - put them in waiting room
      userStatusMap.set(socket.id, 'waiting');
      if (!roomWaitingMap.has(roomId)) {
        roomWaitingMap.set(roomId, []);
      }
      roomWaitingMap.get(roomId).push(socket.id);
      console.log(`User ${socket.id} is waiting in room ${roomId}`);

      // Notify host about waiting participant
      const hostSocketId = roomHostMap.get(roomId);
      io.to(hostSocketId).emit('participant-waiting', {
        socketId: socket.id,
        userId: userId,
        waitingList: roomWaitingMap.get(roomId)
      });

      // Send waiting state to the participant
      socket.emit('waiting-for-admission', {
        message: 'Waiting for host to admit you'
      });

      return; // Don't send all-users yet - they're waiting
    }

    // Host only: send all admitted users
    socket.emit(
      "all-users",
      others
        .filter((id) => userStatusMap.get(id) === 'admitted')
        .map((id) => ({
          socketId: id,
          userId: userSocketMap.get(id)
        }))
    );

    // Notify others that host joined
    socket.to(roomId).emit("user-connected", socket.id);
  });

  socket.on("admit-participant", (data) => {
    const { roomId, socketId } = data;
    const hostSocketId = roomHostMap.get(roomId);

    // Verify host is making this request
    if (socket.id !== hostSocketId) {
      console.log(`Unauthorized admit attempt by ${socket.id}`);
      return;
    }

    // Update participant status
    userStatusMap.set(socketId, 'admitted');

    // Remove from waiting list
    if (roomWaitingMap.has(roomId)) {
      const waitingList = roomWaitingMap.get(roomId);
      const index = waitingList.indexOf(socketId);
      if (index > -1) {
        waitingList.splice(index, 1);
      }
    }

    // Send admitted notification to participant
    io.to(socketId).emit('participant-admitted', {
      message: 'You have been admitted'
    });

    // Send updated waiting list to host
    io.to(hostSocketId).emit('waiting-list-updated', {
      waitingList: roomWaitingMap.get(roomId) || []
    });

    // Send the participant to connect with all admitted users
    const room = io.sockets.adapter.rooms.get(roomId) || new Set();
    const admittedUsers = [...room]
      .filter((id) => id !== socketId && userStatusMap.get(id) === 'admitted')
      .map((id) => ({
        socketId: id,
        userId: userSocketMap.get(id)
      }));

    io.to(socketId).emit('all-users', admittedUsers);

    // Notify other admitted users about the new participant
    io.to(roomId).emit('user-connected', socketId);

    console.log(`Participant ${socketId} admitted to room ${roomId}`);
  });

  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", {
      from: data.from,
      signal: data.signal
    });
  });

  socket.on("disconnect", () => {
    const userId = userSocketMap.get(socket.id);
    const roomId = socketRoomMap.get(socket.id);

    userSocketMap.delete(socket.id);
    socketRoomMap.delete(socket.id);

    // Clean up room mappings
    for (const [rId, hostId] of roomHostMap.entries()) {
      if (hostId === socket.id) {
        // Host disconnected - clean up entire room
        roomHostMap.delete(rId);
        roomWaitingMap.delete(rId);
        console.log(`Room ${rId} closed - host disconnected`);
      }
    }

    // Remove from waiting list if applicable
    for (const [rId, waitingList] of roomWaitingMap.entries()) {
      const index = waitingList.indexOf(socket.id);
      if (index > -1) {
        waitingList.splice(index, 1);
      }
    }

    userStatusMap.delete(socket.id);

    // Notify others in the room
    if (roomId) {
      socket.to(roomId).emit("user-disconnected", socket.id);
    }

    console.log("Socket disconnected:", socket.id);
  });
});

/* ========================
   START SERVER
 ======================== */
const PORT = process.env.PORT || 5000;

// Export app for Vercel
export default app;

// Only listen if running locally
if (process.env.NODE_ENV !== "production") {
  server.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
  );
}
