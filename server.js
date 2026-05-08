const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e9 // Permite uploads de até 100MB via socket
});

// Garante que a pasta de uploads exista
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer (Upload de arquivos sem restrição rígida de tamanho)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 1000 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rota de Upload
app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    
    const mime = req.file.mimetype;
    let type = 'file';
    if (mime.startsWith('image/')) type = 'image';
    if (mime.startsWith('video/')) type = 'video';
    if (mime.startsWith('audio/')) type = 'audio';

    res.json({ url: `/uploads/${req.file.filename}`, type: type });
});

// --- SISTEMA MULTI-SERVIDORES (Em Memória) ---
const activeUsers = new Map();
// Servidor inicial padrão
const servers = {
    'global': { id: 'global', name: 'Danicord Global', icon: 'fa-globe', messages: [] }
};

io.on('connection', (socket) => {
    console.log('Um usuário conectou:', socket.id);

    // Quando o usuário loga
    socket.on('user joined', ({ user, inviteId }) => {
        activeUsers.set(socket.id, user);
        
        // Verifica se ele veio por um link de convite válido
        let serverToJoin = 'global';
        if (inviteId && servers[inviteId]) {
            serverToJoin = inviteId;
        }

        joinServer(socket, serverToJoin);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // Criar um novo servidor
    socket.on('create server', (data) => {
        const newServerId = 'srv_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        servers[newServerId] = {
            id: newServerId,
            name: data.name,
            icon: 'fa-server',
            messages: []
        };
        joinServer(socket, newServerId);
    });

    // Trocar de servidor
    socket.on('join server', (serverId) => {
        if (servers[serverId]) {
            joinServer(socket, serverId);
        } else {
            socket.emit('error message', 'Servidor não encontrado ou convite expirou.');
        }
    });

    // Atualizar o Perfil
    socket.on('update profile', (newProfile) => {
        activeUsers.set(socket.id, newProfile);
        socket.emit('profile updated', newProfile);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // Receber e enviar mensagem
    socket.on('chat message', (msgData) => {
        const user = activeUsers.get(socket.id);
        const serverId = msgData.serverId || 'global';
        
        if (!user || !servers[serverId]) return;

        const message = {
            id: Date.now().toString(),
            user: user,
            text: msgData.text,
            mediaUrl: msgData.mediaUrl,
            mediaType: msgData.mediaType,
            timestamp: new Date().toISOString()
        };
        
        // Mantém as últimas 150 mensagens por sala
        if (servers[serverId].messages.length > 150) servers[serverId].messages.shift();
        servers[serverId].messages.push(message);

        io.to(serverId).emit('chat message', { serverId, message });
    });

    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });

    // Função auxiliar para colocar o usuário numa sala
    function joinServer(socket, serverId) {
        // Sai das outras salas (exceto o próprio ID do socket)
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });

        socket.join(serverId);
        const user = activeUsers.get(socket.id);

        socket.emit('server data', {
            server: servers[serverId],
            history: servers[serverId].messages
        });

        io.to(serverId).emit('chat message', {
            serverId: serverId,
            message: {
                type: 'system',
                text: `${user ? user.name : 'Alguém'} entrou no servidor!`,
                timestamp: new Date().toISOString()
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Danicord rodando na porta ${PORT}`));
