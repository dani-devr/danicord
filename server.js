const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e9 // Limite de 1GB
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 1e9 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    
    const mime = req.file.mimetype;
    let type = 'file';
    if (mime.startsWith('image/')) type = 'image';
    if (mime.startsWith('video/')) type = 'video';
    if (mime.startsWith('audio/')) type = 'audio';

    res.json({ url: `/uploads/${req.file.filename}`, type: type });
});

// --- SISTEMAS DE MODERAÇÃO E ESTADO (MEMÓRIA) ---
const activeUsers = new Map();
const bannedIPs = new Set();
const ipToUser = new Map(); // Anti-Alt: Salva a conta original do IP

const servers = {
    'global': { id: 'global', name: 'Danicord Global', icon: 'fa-globe', type: 'public', messages: [] }
};

io.on('connection', (socket) => {
    // Captura o IP real (funciona no Render.com)
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    console.log('Tentativa de conexão:', socket.id, 'IP:', clientIp);

    // 1. VERIFICAÇÃO DE BANIMENTO ABSOLUTO
    if (bannedIPs.has(clientIp)) {
        socket.emit('banned permanently');
        socket.disconnect(true);
        return;
    }

    // 2. FORÇA O LOGIN SE O IP JÁ TEM CONTA (Anti-Alt Implacável)
    if (ipToUser.has(clientIp)) {
        socket.emit('force login', ipToUser.get(clientIp));
    }

    socket.msgTimestamps = [];

    // Quando o usuário entra
    socket.on('user joined', ({ user, inviteId }) => {
        if (bannedIPs.has(clientIp)) return;

        // Se o IP já tem uma conta registrada, sobrepõe a tentativa do usuário (ele não pode criar alt)
        if (ipToUser.has(clientIp)) {
            user = ipToUser.get(clientIp);
        } else {
            // Primeiro acesso do IP, registra essa conta como a oficial dele
            ipToUser.set(clientIp, user);
        }

        user.socketId = socket.id;
        user.ip = clientIp; // Salva o IP no objeto para o admin poder banir
        activeUsers.set(socket.id, user);
        
        let serverToJoin = 'global';
        if (inviteId && servers[inviteId]) serverToJoin = inviteId;

        socket.emit('initial servers', Object.values(servers).filter(s => s.type === 'public'));
        joinServer(socket, serverToJoin);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // Criação de Servidores e Grupos
    socket.on('create server', (data) => {
        const newServerId = 'srv_' + Date.now().toString(36);
        servers[newServerId] = { id: newServerId, name: data.name, icon: 'fa-server', type: 'public', messages: [] };
        io.emit('server created', servers[newServerId]); 
        joinServer(socket, newServerId);
    });

    socket.on('create group', (data) => {
        const newServerId = 'grp_' + Date.now().toString(36);
        servers[newServerId] = { id: newServerId, name: data.name, icon: 'fa-users', type: 'group', messages: [] };

        const membersToJoin = [...data.members, socket.id];
        membersToJoin.forEach(memberId => {
            const memberSocket = io.sockets.sockets.get(memberId);
            if (memberSocket) {
                memberSocket.join(newServerId);
                memberSocket.emit('server created', servers[newServerId]);
            }
        });
        joinServer(socket, newServerId);
    });

    socket.on('join server', (serverId) => {
        if (servers[serverId]) joinServer(socket, serverId);
    });

    // Atualização de Perfil (Bio, Avatar, Cor)
    socket.on('update profile', (newProfile) => {
        const current = activeUsers.get(socket.id);
        if (current) {
            newProfile.socketId = socket.id;
            newProfile.ip = current.ip;
            activeUsers.set(socket.id, newProfile);
            ipToUser.set(current.ip, newProfile); // Atualiza a conta oficial do IP
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });

    // Chat e Anti-Spam
    socket.on('chat message', (msgData) => {
        const user = activeUsers.get(socket.id);
        const serverId = msgData.serverId || 'global';
        if (!user || !servers[serverId]) return;

        const now = Date.now();
        socket.msgTimestamps.push(now);
        if (socket.msgTimestamps.length > 5) {
            socket.msgTimestamps.shift();
            if (now - socket.msgTimestamps[0] < 2000) {
                socket.emit('error message', 'Calma! Você está enviando mensagens muito rápido (Spam).');
                return;
            }
        }

        const message = {
            id: Date.now().toString() + Math.random().toString(36).substring(7),
            user: user,
            text: msgData.text,
            mediaUrl: msgData.mediaUrl,
            mediaType: msgData.mediaType,
            replyTo: msgData.replyTo,
            timestamp: new Date().toISOString()
        };
        
        if (servers[serverId].messages.length > 200) servers[serverId].messages.shift();
        servers[serverId].messages.push(message);

        io.to(serverId).emit('chat message', { serverId, message });
    });

    // --- PODERES DO ADMIN (dypz) ---
    socket.on('delete message', ({ serverId, msgId }) => {
        const user = activeUsers.get(socket.id);
        if (user && user.name.toLowerCase() === 'dypz') {
            if (servers[serverId]) {
                servers[serverId].messages = servers[serverId].messages.filter(m => m.id !== msgId);
                io.to(serverId).emit('message deleted', msgId);
            }
        }
    });

    socket.on('ban user', (targetSocketId) => {
        const admin = activeUsers.get(socket.id);
        if (admin && admin.name.toLowerCase() === 'dypz') {
            const targetUser = activeUsers.get(targetSocketId);
            if (targetUser) {
                bannedIPs.add(targetUser.ip); // BANIMENTO REAL DO IP
                
                // Emite evento para todos os sockets conectados com esse IP
                io.sockets.sockets.forEach((s) => {
                    const sIp = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
                    let cleanIp = sIp.includes(',') ? sIp.split(',')[0].trim() : sIp;
                    if (cleanIp === targetUser.ip) {
                        s.emit('banned permanently');
                        s.disconnect(true);
                    }
                });
                
                io.emit('system message', `dypz acaba de banir ${targetUser.name} permanentemente.`);
            }
        }
    });

    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });

    function joinServer(socket, serverId) {
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id && room !== serverId) socket.leave(room);
        });
        socket.join(serverId);
        socket.emit('server data', {
            server: servers[serverId],
            history: servers[serverId].messages
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Danicord rodando na porta ${PORT}`));
