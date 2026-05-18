'use strict';

var http = require('http');
var WebSocket = require('ws');

var PORT = process.env.PORT || 8080;

// HTTP server (Render.com health check + WebSocket upgrade)
var httpServer = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DARK SURVIVOR Multiplayer Server');
});

var wss = new WebSocket.Server({ server: httpServer });

// rooms: Map<roomId, { id, passphrase, hostSocketId, players[], state, createdAt }>
var rooms = new Map();
var socketToId = new WeakMap();
var idToSocket = new Map();
var playerToRoom = new Map();

var WORDS = [
  'WOLF','CROW','BEAR','HAWK','VIPER','SHADE','IRON','BONE','DARK','SOUL',
  'RAVEN','NIGHT','BLOOD','MIST','FIRE','FROST','STORM','VOID','FLAME','ECHO'
];

function generatePassphrase() {
  var w = WORDS[Math.floor(Math.random() * WORDS.length)];
  var n = 1000 + Math.floor(Math.random() * 9000);
  return w + '-' + n;
}

function shortId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastToRoom(roomId, obj, excludeSocketId) {
  var room = rooms.get(roomId);
  if (!room) return;
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    if (p.socketId === excludeSocketId) continue;
    send(idToSocket.get(p.socketId), obj);
  }
}

function broadcastToAll(roomId, obj) {
  broadcastToRoom(roomId, obj, null);
}

function findRoomByPassphrase(phrase) {
  var result = null;
  rooms.forEach(function(room) { if (room.passphrase === phrase) result = room; });
  return result;
}

function removePlayerFromRoom(socketId) {
  var roomId = playerToRoom.get(socketId);
  if (!roomId) return;
  var room = rooms.get(roomId);
  if (!room) { playerToRoom.delete(socketId); return; }

  room.players = room.players.filter(function(p) { return p.socketId !== socketId; });
  playerToRoom.delete(socketId);

  if (room.players.length === 0) { rooms.delete(roomId); return; }

  broadcastToAll(roomId, { type: 'player_left', socketId: socketId });

  if (socketId === room.hostSocketId) {
    var newHost = room.players[0];
    room.hostSocketId = newHost.socketId;
    broadcastToAll(roomId, { type: 'host_changed', newHostSocketId: newHost.socketId });
  }
}

wss.on('connection', function(ws) {
  var socketId = shortId();
  socketToId.set(ws, socketId);
  idToSocket.set(socketId, ws);

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'create_room': {
        if (playerToRoom.has(socketId)) {
          send(ws, { type: 'error', code: 'ALREADY_IN_ROOM', message: '既に部屋に入っています' });
          return;
        }
        var roomId = shortId();
        var passphrase = generatePassphrase();
        var player = { socketId: socketId, name: msg.name || 'Host', charId: msg.charId || '', ready: false };
        var room = { id: roomId, passphrase: passphrase, hostSocketId: socketId, players: [player], state: 'waiting', createdAt: Date.now() };
        rooms.set(roomId, room);
        playerToRoom.set(socketId, roomId);
        send(ws, { type: 'room_created', roomId: roomId, passphrase: passphrase, mySocketId: socketId, players: room.players });
        break;
      }

      case 'join_room': {
        if (playerToRoom.has(socketId)) {
          send(ws, { type: 'error', code: 'ALREADY_IN_ROOM', message: '既に部屋に入っています' });
          return;
        }
        var phrase = (msg.passphrase || '').trim().toUpperCase();
        var targetRoom = findRoomByPassphrase(phrase);
        if (!targetRoom) { send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: '部屋が見つかりません: ' + phrase }); return; }
        if (targetRoom.state !== 'waiting') { send(ws, { type: 'error', code: 'GAME_ALREADY_STARTED', message: 'ゲームはすでに開始されています' }); return; }
        if (targetRoom.players.length >= 4) { send(ws, { type: 'error', code: 'ROOM_FULL', message: '部屋が満員です' }); return; }
        var newPlayer = { socketId: socketId, name: msg.name || 'Player', charId: msg.charId || '', ready: false };
        targetRoom.players.push(newPlayer);
        playerToRoom.set(socketId, targetRoom.id);
        send(ws, { type: 'room_joined', roomId: targetRoom.id, passphrase: targetRoom.passphrase, mySocketId: socketId, hostSocketId: targetRoom.hostSocketId, players: targetRoom.players });
        broadcastToRoom(targetRoom.id, { type: 'player_joined', player: newPlayer }, socketId);
        break;
      }

      case 'list_rooms': {
        var list = [];
        rooms.forEach(function(r) {
          if (r.state === 'waiting' && r.players.length < 4) {
            var hostPlayer = null;
            for (var i = 0; i < r.players.length; i++) {
              if (r.players[i].socketId === r.hostSocketId) { hostPlayer = r.players[i]; break; }
            }
            list.push({ roomId: r.id, passphrase: r.passphrase, playerCount: r.players.length, hostName: hostPlayer ? hostPlayer.name : 'Host' });
          }
        });
        send(ws, { type: 'room_list', rooms: list });
        break;
      }

      case 'player_ready': {
        var rid = playerToRoom.get(socketId);
        if (!rid) return;
        var rm = rooms.get(rid);
        if (!rm) return;
        for (var i = 0; i < rm.players.length; i++) {
          if (rm.players[i].socketId === socketId) {
            rm.players[i].ready = true;
            if (msg.charId) rm.players[i].charId = msg.charId;
            if (msg.name) rm.players[i].name = msg.name;
            broadcastToAll(rid, { type: 'player_ready_update', socketId: socketId, ready: true, charId: msg.charId || '', name: msg.name || '' });
            break;
          }
        }
        break;
      }

      case 'start_game': {
        var rid2 = playerToRoom.get(socketId);
        if (!rid2) return;
        var rm2 = rooms.get(rid2);
        if (!rm2) return;
        if (rm2.hostSocketId !== socketId) { send(ws, { type: 'error', code: 'NOT_HOST', message: 'ホストのみ開始できます' }); return; }
        rm2.state = 'playing';
        broadcastToAll(rid2, { type: 'game_started', seed: Math.floor(Math.random() * 2147483647) });
        break;
      }

      case 'relay': {
        var rid3 = playerToRoom.get(socketId);
        if (!rid3) return;
        broadcastToRoom(rid3, { type: 'relayed', fromSocketId: socketId, payload: msg.payload }, socketId);
        break;
      }

      case 'game_ended': {
        var rid4 = playerToRoom.get(socketId);
        if (!rid4) return;
        var rm4 = rooms.get(rid4);
        if (rm4 && rm4.hostSocketId === socketId) {
          broadcastToRoom(rid4, { type: 'game_ended' }, socketId);
          rm4.players.forEach(function(p) { playerToRoom.delete(p.socketId); });
          rooms.delete(rid4);
        }
        break;
      }

      case 'ping': send(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', function() { removePlayerFromRoom(socketId); idToSocket.delete(socketId); });
  ws.on('error', function() { removePlayerFromRoom(socketId); idToSocket.delete(socketId); });
});

// Stale room cleanup every 30 minutes
setInterval(function() {
  var now = Date.now();
  rooms.forEach(function(room, id) {
    if (room.state === 'waiting' && now - room.createdAt > 3 * 60 * 60 * 1000) rooms.delete(id);
    if (room.state === 'playing' && now - room.createdAt > 40 * 60 * 1000) rooms.delete(id);
  });
}, 30 * 60 * 1000);

httpServer.listen(PORT, function() {
  console.log('DARK SURVIVOR relay server listening on port ' + PORT);
});
