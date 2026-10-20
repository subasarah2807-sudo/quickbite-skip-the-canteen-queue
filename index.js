require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const { initAll } = require('./seed');
const { startExpiryCron } = require('./cron');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const slotsRoutes = require('./routes/slots');
const ordersRoutes = require('./routes/orders');
const statsRoutes = require('./routes/stats');
const stationsRoutes = require('./routes/stations');
const { initStationWorkers } = require('./stationWorkers');

const app = express();
const server = http.createServer(app);

// Setup Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
  }
});

app.use(cors());
app.use(express.json());

// Pass io instance to express app so routes can broadcast
app.set('io', io);

// Initialize DB and default seeds
initAll();

// Start no-show auto-expiry cron
startExpiryCron(io);

// Start multi-station parallel worker engine
initStationWorkers(() => io);

// Socket.io room management
io.on('connection', (socket) => {
  // Client joins their personal user room
  socket.on('join_user', (userId) => {
    if (userId) {
      socket.join(`user_${userId}`);
    }
  });

  // Staff joins staff dashboard room
  socket.on('join_staff', () => {
    socket.join('staff_room');
  });

  socket.on('disconnect', () => {
    // disconnected
  });
});

// API Routes
app.use('/api', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/slots', slotsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/sheets', statsRoutes);
app.use('/api/stations', stationsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'QuickBite Canteen Server', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[QuickBite Backend] Server listening on port ${PORT}`);
});

module.exports = { app, server, io };

