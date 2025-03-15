const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fileUpload = require('express-fileupload');
const XLSX = require('xlsx');
const path = require('path');
const redis = require('redis');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const { MongoClient } = require('mongodb');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 3000;

// ================== Custom MongoDB Store ==================
class MongoSessionStore {
    constructor(mongoClient) {
        this.client = mongoClient;
        this.collection = this.client.db().collection('whatsapp_sessions');
    }

    async sessionExists(sessionId) {
        const doc = await this.collection.findOne({ _id: sessionId });
        return !!doc;
    }

    async get(sessionId) {
        const doc = await this.collection.findOne({ _id: sessionId });
        return doc ? doc.session : null;
    }

    async set(sessionId, sessionData) {
        await this.collection.updateOne(
            { _id: sessionId },
            { $set: { session: sessionData } },
            { upsert: true }
        );
    }

    async delete(sessionId) {
        await this.collection.deleteOne({ _id: sessionId });
    }

    async list() {
        const sessions = await this.collection.find({}).toArray();
        return sessions.map(session => session._id);
    }
}

// ================== Database Connections ==================
const redisClient = redis.createClient({
    url: process.env.REDIS_URL
});

const mongoClient = new MongoClient(process.env.MONGODB_URI || '', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const mongoStore = new MongoSessionStore(mongoClient);

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('✅ Redis connected successfully');

        if (!process.env.MONGODB_URI) {
            throw new Error('MONGODB_URI is not defined in .env file');
        }

        await mongoClient.connect();
        console.log('✅ MongoDB connected successfully');

        // ================== Session Configuration ==================
        app.use(session({
            store: new RedisStore({
                client: redisClient,
                prefix: "whatsapp:",
                ttl: 86400
            }),
            secret: process.env.SESSION_SECRET || 'Admin$265431@Mada',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: false,
                httpOnly: true,
                maxAge: 86400000
            }
        }));

        initializeApp();
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        process.exit(1);
    }
})();

// ================== WhatsApp Client Configuration ==================
let client = null;
let qrCodeData = null;
let progressClients = [];
let statusClients = [];
let resultClients = [];
let messageStatusClients = [];
let isInitializing = false;
let initRetryCount = 0;
let clientStatus = 'not_ready';
const MAX_RETRIES = 3;

// ================== Core Functions ==================
async function checkAuthState() {
    if (!client) {
        console.log('⚠️ Client not initialized');
        return false;
    }
    try {
        return await client.getState() === 'CONNECTED';
    } catch (error) {
        console.error('🔴 Auth check failed:', error);
        if (error.message.includes('evaluate')) await initializeClient();
        return false;
    }
}

async function ensureClientReady() {
    if (!client || clientStatus !== 'ready') {
        throw new Error('WhatsApp client is not ready. Please scan the QR code first.');
    }

    try {
        if (!await checkAuthState()) {
            throw new Error('WhatsApp connection is not stable. Please try reconnecting.');
        }
    } catch (error) {
        console.error('Client readiness check failed:', error);
        throw error;
    }
}

async function initializeClient() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        if (client) {
            try {
                console.log('🔄 Destroying existing client...');
                await client.destroy();
            } catch (destroyError) {
                console.warn('⚠️ Error during client destruction:', destroyError);
            } finally {
                client = null;
                clientStatus = 'not_ready';
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log('🔄 Initializing new client...');
        clientStatus = 'initializing';
        qrCodeData = null;

        client = new Client({
            authStrategy: new RemoteAuth({
                store: mongoStore,
                backupSyncIntervalMs: 300000,
                clientId: 'whatsapp-bot'
            }),
            puppeteer: {
                browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            }
        });

        client.on('qr', async (qr) => {
            console.log('🔵 QR Received');
            qrCodeData = await qrcode.toDataURL(qr);
            clientStatus = 'scan_qr';
            notifyClients('scan_qr');
        });

        client.on('ready', async () => {
            console.log('🟢 Client Ready');
            if (await checkAuthState()) {
                clientStatus = 'ready';
                notifyClients('ready');
                initRetryCount = 0;
            } else {
                clientStatus = 'error';
                console.log('🟡 False ready state');
                await initializeClient();
            }
        });

        client.on('auth_failure', async () => {
            console.log('🔴 Auth Failed');
            clientStatus = 'error';
            if (initRetryCount++ < MAX_RETRIES) await initializeClient();
            else notifyClients('error');
        });

        client.on('disconnected', async () => {
            console.log('🔴 Client Disconnected');
            clientStatus = 'disconnected';
            await initializeClient();
        });

        await client.initialize();
    } catch (error) {
        console.error('❌ Initialization Failed:', error);
        clientStatus = 'error';
        if (initRetryCount++ < MAX_RETRIES) {
            console.log(`🔄 Retrying initialization (attempt ${initRetryCount}/${MAX_RETRIES})...`);
            setTimeout(initializeClient, 5000);
        } else {
            console.error('❌ Max retry attempts reached');
            notifyClients('error');
        }
    } finally {
        isInitializing = false;
    }
}

// ================== Helper Functions ==================
function formatPhoneNumber(number) {
    return `${number.trim().replace('+', '')}@c.us`;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function notifyClients(status) {
    console.log('Notifying clients of status:', status);
    statusClients.forEach(clientRes => {
        try {
            clientRes.write(`data: ${status}\n\n`);
        } catch (err) {
            console.error('Failed to notify client:', err);
            statusClients = statusClients.filter(c => c !== clientRes);
        }
    });
}

// ================== Middleware & Routes ==================
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/qrcode', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Content-Type': 'application/json',
    });
    
    if (!client) return res.json({ status: 'initializing', qrCode: null });
    if (clientStatus === 'ready') return res.json({ status: 'authenticated', qrCode: null });
    if (qrCodeData) return res.json({ status: 'waiting_for_scan', qrCode: qrCodeData });
    res.json({ status: clientStatus, qrCode: null });
});

app.post('/refresh-qr', async (req, res) => {
    try {
        console.log('🔄 Manual QR refresh');
        initRetryCount = 0;
        await initializeClient();
        res.json({ status: 'refresh_initiated' });
    } catch (error) {
        console.error('❌ Refresh failed:', error);
        res.status(500).json({ error: 'Refresh failed' });
    }
});

// ================== SSE Endpoints ==================
function setupSSE(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.write('\n');
    return res;
}

app.get('/status', (req, res) => {
    const clientRes = setupSSE(res);
    clientRes.write(`data: ${clientStatus}\n\n`);
    statusClients.push(clientRes);
    req.on('close', () => {
        statusClients = statusClients.filter(c => c !== clientRes);
    });
});


app.get('/progress', (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.write("\n");
    progressClients.push(res);
    req.on('close', () => {
        progressClients = progressClients.filter(client => client !== res);
    });
});

app.get('/results', (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.write("\n");
    resultClients.push(res);
    req.on('close', () => {
        resultClients = resultClients.filter(client => client !== res);
    });
});

app.get('/message-status', (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    messageStatusClients.push(res);
    req.on('close', () => {
        messageStatusClients = messageStatusClients.filter(client => client !== res);
    });
});

app.post('/send-messages', async (req, res) => {
    try {
        await ensureClientReady();
        let json;
        if (req.files && req.files.recipients) {
            const recipientsFile = req.files.recipients;
            const workbook = XLSX.read(recipientsFile.data, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            json = XLSX.utils.sheet_to_json(sheet);
        } else if (req.body.recipients) {
            json = req.body.recipients;
            if (typeof json === 'string') {
                json = JSON.parse(json);
            }
        } else {
            return res.status(400).json({ error: 'No file or recipients data uploaded.' });
        }

        if (!req.body.message) {
            return res.status(400).json({ error: 'Message content is required.' });
        }

        const message = req.body.message;
        const invalidNumbers = [];
        const validNumbers = [];

        json.forEach((row) => {
            const number = row['WhatsApp Number(with country code)'] || row.number;
            if (number && /^\+\d{7,}$/.test(number)) {
                validNumbers.push({
                    formattedNumber: formatPhoneNumber(number),
                    firstName: row['First Name'] || row.firstName,
                    lastName: row['Last Name'] || row.lastName,
                });
            } else {
                invalidNumbers.push(number || 'Invalid number');
            }
        });

        if (validNumbers.length === 0) {
            return res.status(400).json({
                error: 'No valid phone numbers found',
                invalidNumbers,
            });
        }

        const results = {
            success: [],
            failed: [],
            invalidNumbers,
        };

        for (let i = 0; i < validNumbers.length; i++) {
            const { formattedNumber, firstName, lastName } = validNumbers[i];
            const personalizedMessage = message
                .replace('{firstName}', firstName)
                .replace('{lastName}', lastName);

            try {
                await ensureClientReady();
                let retries = 3;
                let error;
                while (retries > 0) {
                    try {
                        await client.sendMessage(formattedNumber, personalizedMessage);
                        const statusData = {
                            number: formattedNumber,
                            message: "Message sent successfully",
                            success: true,
                            timestamp: new Date().toISOString(),
                            details: personalizedMessage
                        };
                        messageStatusClients.forEach(client => {
                            try {
                                client.write(`data: ${JSON.stringify(statusData)}\n\n`);
                            } catch (err) {
                                messageStatusClients = messageStatusClients.filter(c => c !== client);
                            }
                        });
                        results.success.push(formattedNumber);
                        break;
                    } catch (err) {
                        error = err;
                        retries--;
                        if (retries > 0) await delay(2000);
                    }
                }
                if (retries === 0) throw error;
            } catch (err) {
                const statusData = {
                    number: formattedNumber,
                    message: `Failed to send: ${err.message || 'Unknown error'}`,
                    success: false,
                    timestamp: new Date().toISOString(),
                    error: err.message || 'Unknown error'
                };
                messageStatusClients.forEach(client => {
                    try {
                        client.write(`data: ${JSON.stringify(statusData)}\n\n`);
                    } catch (err) {
                        messageStatusClients = messageStatusClients.filter(c => c !== client);
                    }
                });
                results.failed.push(formattedNumber);
            }

            const progress = Math.floor(((i + 1) / validNumbers.length) * 100);
            progressClients.forEach(client => {
                try {
                    client.write(`data: ${progress}\n\n`);
                } catch (err) {
                    progressClients = progressClients.filter(c => c !== client);
                }
            });

            await delay(Math.max(3000, req.body.interval ? parseFloat(req.body.interval) * 1000 : 3000));
        }

        res.json({
            status: 'completed',
            summary: {
                total: json.length,
                valid: validNumbers.length,
                invalid: invalidNumbers.length,
                sent: results.success.length,
                failed: results.failed.length,
            },
            details: results,
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to send messages',
            message: error.message,
            details: error.stack
        });
    }
});

app.post('/signout', async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
        }
        qrCodeData = null;
        clientStatus = 'initializing';
        notifyClients('initializing');
        
        setTimeout(async () => {
            initRetryCount = 0;
            await initializeClient();
        }, 2000);
        
        res.json({ status: 'signed_out' });
    } catch (error) {
        res.status(500).json({ error: 'Sign out failed', message: error.message });
    }
});

// ================== Server Initialization ==================
function initializeApp() {
    app.listen(port, () => {
        console.log(`🚀 Server running at http://localhost:${port}`);
    });
    initializeClient();
}

// ================== Error Handling ==================
app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Internal server error' });
});