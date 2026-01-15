import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import summaryRoutes from './routes/summary.js';
import authRoutes from './routes/auth.js';

dotenv.config();
const app = express();

// Connect DB
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB connection failed" });
  }
});
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve uploaded audio files
app.use('/uploads', express.static('uploads'));

// api
app.use('/api/auth', authRoutes);
app.use('/api/summary', summaryRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*', // later restrict to frontend URL
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 5000;

// Keep a mapping of socket.id -> userId for easy lookups
const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('User connected: ', socket.id);

  // Join a room
  socket.on('join-room', (roomId, userId) => {
    // store mapping
    userSocketMap.set(socket.id, userId);

    socket.join(roomId);
    console.log(`${userId} joined room: ${roomId} (socket: ${socket.id})`);

    // Send back list of existing sockets in room (excluding the joining socket)
    const room = io.sockets.adapter.rooms.get(roomId) || new Set();
    const otherSocketIds = Array.from(room).filter((id) => id !== socket.id);
    socket.emit('all-users', otherSocketIds.map((id) => ({ socketId: id, userId: userSocketMap.get(id) })));

    // Notify others a new user (send the joining socket id)
    socket.to(roomId).emit('user-connected', socket.id);

    // Handle explicit leave
    socket.on('leave-room', (roomIdToLeave, userIdLeaving) => {
      socket.leave(roomIdToLeave);
      console.log(`${userIdLeaving} left room: ${roomIdToLeave}`);
      socket.to(roomIdToLeave).emit('user-disconnected', socket.id);
    });

    // Handle disconnecting - notify rooms before fully disconnected
    socket.on('disconnecting', () => {
      const uid = userSocketMap.get(socket.id);
      console.log(`${uid} (socket: ${socket.id}) disconnecting`);
      // for each room the socket is in, notify others
      for (const roomName of socket.rooms) {
        if (roomName === socket.id) continue; // skip own room
        socket.to(roomName).emit('user-disconnected', socket.id);
      }
      userSocketMap.delete(socket.id);
    });
  });

  // Signal data for WebRTC
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', {
      from: data.from,
      signal: data.signal,
    });
  });
});

// server.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });