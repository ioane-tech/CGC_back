const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

const rooms = new Map();
const playerRooms = new Map();

class GameRoom {
  constructor(id, hostId, maxPlayers = 4) {
    this.id = id;
    this.hostId = hostId;
    this.maxPlayers = maxPlayers;
    this.players = new Map(); // playerId -> playerData
    this.gameStarted = false;
    this.gameState = {
      coins: new Map(),
      enemies: new Map(),
      blocks: new Map()
    };
    this.createdAt = Date.now();
  }

  addPlayer(playerId, playerData) {
    if (this.players.size >= this.maxPlayers) {
      return { success: false, error: 'Room is full' };
    }

    this.players.set(playerId, {
      id: playerId,
      ...playerData,
      joinedAt: Date.now()
    });

    return { success: true };
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    
    if (playerId === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }
  }

  getPlayerData() {
    return Object.fromEntries(this.players);
  }

  canStart() {
    return this.players.size >= 1 && !this.gameStarted;
  }

  isEmpty() {
    return this.players.size === 0;
  }
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupEmptyRooms() {
  for (const [roomId, room] of rooms.entries()) {
    if (room.isEmpty()) {
      console.log(`Cleaning up empty room: ${roomId}`);
      rooms.delete(roomId);
    }
  }
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('createRoom', (data) => {
    try {
      const roomId = generateRoomId();
      const room = new GameRoom(roomId, socket.id);
      
      const result = room.addPlayer(socket.id, data.playerData);
      if (!result.success) {
        socket.emit('roomError', { error: result.error });
        return;
      }

      rooms.set(roomId, room);
      playerRooms.set(socket.id, roomId);
      
      socket.join(roomId);

      console.log(`Room ${roomId} created by ${socket.id}`);
      
      socket.emit('roomCreated', {
        roomId: roomId,
        isHost: true,
        players: room.getPlayerData()
      });

    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('roomError', { error: 'Failed to create room' });
    }
  });

  socket.on('joinRoom', (data) => {
    try {
      const { roomId, playerData } = data;
      const room = rooms.get(roomId);

      if (!room) {
        socket.emit('roomError', { error: 'Room not found' });
        return;
      }

      if (room.gameStarted) {
        socket.emit('roomError', { error: 'Game already started' });
        return;
      }

      const result = room.addPlayer(socket.id, playerData);
      if (!result.success) {
        socket.emit('roomError', { error: result.error });
        return;
      }

      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`Player ${socket.id} joined room ${roomId}`);

      socket.emit('roomJoined', {
        roomId: roomId,
        isHost: false,
        players: room.getPlayerData()
      });

      socket.to(roomId).emit('playerJoined', {
        playerId: socket.id,
        playerData: room.players.get(socket.id)
      });

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('roomError', { error: 'Failed to join room' });
    }
  });

  socket.on('getRoomList', () => {
    try {
      const availableRooms = [];
      
      console.log(`Getting room list. Total rooms: ${rooms.size}`);
      
      for (const [roomId, room] of rooms.entries()) {
        console.log(`Room ${roomId}: gameStarted=${room.gameStarted}, players=${room.players.size}/${room.maxPlayers}`);
        
        if (!room.gameStarted && room.players.size < room.maxPlayers) {
          availableRooms.push({
            id: roomId,
            playerCount: room.players.size,
            maxPlayers: room.maxPlayers,
            createdAt: room.createdAt
          });
        }
      }

      console.log(`Sending ${availableRooms.length} available rooms to client`);
      socket.emit('roomList', availableRooms);
    } catch (error) {
      console.error('Error getting room list:', error);
      socket.emit('error', { error: 'Failed to get room list' });
    }
  });

  socket.on('startGame', (data) => {
    try {
      const roomId = playerRooms.get(socket.id);
      const room = rooms.get(roomId);

      if (!room) {
        socket.emit('roomError', { error: 'Room not found' });
        return;
      }

      if (room.hostId !== socket.id) {
        socket.emit('roomError', { error: 'Only host can start the game' });
        return;
      }

      if (!room.canStart()) {
        socket.emit('roomError', { error: 'Cannot start game' });
        return;
      }

      room.gameStarted = true;
      console.log(`Game started in room ${roomId}`);

      io.to(roomId).emit('gameStarted', {
        roomId: roomId,
        players: room.getPlayerData()
      });

    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('roomError', { error: 'Failed to start game' });
    }
  });

  socket.on('playerInput', (data) => {
    try {
      const roomId = playerRooms.get(socket.id);
      if (!roomId) return;

      socket.to(roomId).emit('playerInput', {
        playerId: socket.id,
        input: data.input,
        timestamp: data.timestamp
      });

    } catch (error) {
      console.error('Error handling player input:', error);
    }
  });

  // Game synchronization events
  socket.on('playerUpdate', (data) => {
    try {
      const roomId = playerRooms.get(socket.id);
      if (!roomId) return;

      const broadcastData = {
        playerId: socket.id,
        playerData: data,
        timestamp: Date.now()
      };

      // Broadcast player position/state to other players in the room
      socket.to(roomId).emit('playerUpdate', broadcastData);

    } catch (error) {
      console.error('Error handling player update:', error);
    }
  });

  socket.on('playerAction', (data) => {
    try {
      const roomId = playerRooms.get(socket.id);
      if (!roomId) return;

      // Broadcast player actions (hammer, build, etc.) to other players
      socket.to(roomId).emit('playerAction', {
        playerId: socket.id,
        action: data.action,
        actionData: data.actionData,
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('Error handling player action:', error);
    }
  });

  socket.on('gameObjectUpdate', (data) => {
    try {
      const roomId = playerRooms.get(socket.id);
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      const { objectData } = data;
      if (objectData.type === 'coin' && objectData.action === 'collected') {
        room.gameState.coins.set(objectData.id, { collected: true, by: socket.id });
      } else if (objectData.type === 'block' && objectData.action === 'created') {
        room.gameState.blocks.set(objectData.id, objectData);
      } else if (objectData.type === 'block' && objectData.action === 'destroyed') {
        room.gameState.blocks.delete(objectData.id);
      }

      socket.to(roomId).emit('gameObjectUpdate', {
        playerId: socket.id,
        objectData: objectData,
        timestamp: data.timestamp
      });

    } catch (error) {
      console.error('Error handling game object update:', error);
    }
  });

  socket.on('leaveRoom', (data) => {
    handlePlayerLeave(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    handlePlayerLeave(socket.id);
  });

  function handlePlayerLeave(playerId) {
    try {
      const roomId = playerRooms.get(playerId);
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      room.removePlayer(playerId);
      playerRooms.delete(playerId);

      socket.to(roomId).emit('playerLeft', {
        playerId: playerId
      });

      if (room.isEmpty()) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
      }

    } catch (error) {
      console.error('Error handling player leave:', error);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'CGC Multiplayer Server',
    rooms: rooms.size,
    players: playerRooms.size
  });
});

app.get('/rooms', (req, res) => {
  const roomList = [];
  for (const [roomId, room] of rooms.entries()) {
    roomList.push({
      id: roomId,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
      gameStarted: room.gameStarted,
      createdAt: room.createdAt
    });
  }
  res.json(roomList);
});

setInterval(cleanupEmptyRooms, 60000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`CGC Multiplayer Server running on port ${PORT}`);
  console.log(`Game client should connect to: http://localhost:${PORT}`);
});
