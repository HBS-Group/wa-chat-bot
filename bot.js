const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fileUpload = require('express-fileupload');
const XLSX = require('xlsx');
const path = require('path');
const redis = require('redis');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const os = require('os');
const fs = require('fs').promises;
const app = express();
const port = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// ================== Redis Setup ==================
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

(async () => {
    try {
        await redisClient.connect();
        console.log('✅ Redis connected successfully');

        // ================== Session Configuration ==================
        app.use(session({
            store: new RedisStore({
                client: redisClient,
                prefix: "whatsapp:",
                ttl: 86400 // 1 day in seconds
            }),
            secret: process.env.SESSION_SECRET || 'Admin$265431@Mada',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: false,
                httpOnly: true,
                maxAge: 86400000 // 1 day in milliseconds
            }
        }));

        initializeApp();
    } catch (error) {
        console.error('❌ Redis connection failed:', error);
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

// Custom Redis store implementation
const redisStore = {
    sessionExists: async (key) => {
        const exists = await redisClient.exists(`whatsapp:${key}`);
        return exists === 1;
    },
    set: async (key, value) => {
        await redisClient.set(`whatsapp:${key}`, JSON.stringify(value));
    },
    get: async (key) => {
        const data = await redisClient.get(`whatsapp:${key}`);
        return data ? JSON.parse(data) : null;
    },
    remove: async (key) => {
        await redisClient.del(`whatsapp:${key}`);
    }
};

// ================== Core Functions ==================
async function checkAuthState() {
    if (!client) {
        console.log('⚠️ Client not initialized');
        return false;
    }
    try {
        const state = await client.getState();
        return state === 'CONNECTED';
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
        const isConnected = await checkAuthState();
        if (!isConnected) {
            throw new Error('WhatsApp connection is not stable. Please try reconnecting.');
        }
    } catch (error) {
        console.error('Client readiness check failed:', error);
        throw new Error('WhatsApp connection is not stable. Please try reconnecting.');
    }
}

const BROWSERLESS_TIMEOUT = 30000;
const CONNECTION_COOLDOWN = 30000;
let lastConnectionAttempt = 0;
let connectionQueue = Promise.resolve();
let currentConnection = null;
let connectionState = 'idle';

// Add these constants near the top
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = [
    'https://your-vercel-domain.vercel.app', // Add your Vercel domain
    'http://localhost:3000'
];

// Update CORS middleware
app.use((req, res, next) => {
    const origin = req.headers.origin || req.headers.host;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

async function initializeClient() {
    try {
        // Check if initialization is already in progress
        if (isInitializing) {
            console.log('Already initializing...');
            return;
        }

        // Check cooldown
        const now = Date.now();
        const timeSinceLastAttempt = now - lastConnectionAttempt;
        if (timeSinceLastAttempt < CONNECTION_COOLDOWN) {
            console.log(`Cooling down. ${Math.ceil((CONNECTION_COOLDOWN - timeSinceLastAttempt)/1000)}s remaining...`);
            return;
        }

        isInitializing = true;
        lastConnectionAttempt = now;
        clientStatus = 'initializing';
        
        // Clean up existing client
        if (client) {
            try {
                await client.destroy();
                await delay(2000);
            } catch (error) {
                console.warn('Client destroy warning:', error);
            }
            client = null;
        }

        qrCodeData = null;
        notifyClients('initializing');

        // Configure browserless
        const puppeteerConfig = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
            timeout: BROWSERLESS_TIMEOUT
        };

        // Initialize client
        client = new Client({
            authStrategy: new RemoteAuth({
                clientId: 'whatsapp-bot',
                store: redisStore,
                backupSyncIntervalMs: 60000,
                dataPath: '/tmp'
            }),
            puppeteer: puppeteerConfig,
            qrMaxRetries: 5,
            restartOnAuthFail: true,
            takeoverOnConflict: false,
            takeoverTimeoutMs: 10000
        });

        // Set up event handlers
        client.on('qr', handleQRCode);
        client.on('ready', handleReady);
        client.on('auth_failure', handleAuthFailure);
        client.on('disconnected', handleDisconnect);

        await client.initialize();
        console.log('WhatsApp client initialized successfully');

    } catch (error) {
        console.error('❌ Initialization Failed:', error);
        clientStatus = 'error';
        notifyClients('error');
    } finally {
        isInitializing = false;
    }
}

// Event handler functions
async function handleQRCode(qr) {
    try {
        qrCodeData = await qrcode.toDataURL(qr);
        clientStatus = 'waiting_for_scan';
        console.log('QR Code ready for scanning');
        notifyClients('scan_qr');
    } catch (error) {
        console.error('QR generation failed:', error);
        clientStatus = 'error';
        notifyClients('error');
    }
}

// Update ready handler to reset strategy
function handleReady() {
    console.log('Client is ready!');
    clientStatus = 'ready';
    notifyClients('ready');
    lastFailedStrategy = null;
    browserlessRetryCount = 0;
    browserlessRetryDelay = BROWSERLESS_INITIAL_RETRY_DELAY;
}

function handleAuthFailure() {
    console.log('Auth failed!');
    clientStatus = 'auth_failed';
    notifyClients('auth_failed');
}

async function handleDisconnect(reason) {
    console.log('Client was disconnected:', reason);
    clientStatus = 'disconnected';
    notifyClients('disconnected');
    
    if (initRetryCount < MAX_RETRIES) {
        initRetryCount++;
        setTimeout(initializeClient, 5000);
    }
}

// ================== Helper Functions ==================
function formatPhoneNumber(number) {
    return `${number.trim().replace('+', '')}@c.us`;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function notifyClients(status) {
    // Send plain status instead of JSON
    console.log('Notifying clients of status:', status);
    
    statusClients = statusClients.filter(client => {
        try {
            client.write(`data: ${status}\n\n`);
            return true;
        } catch (error) {
            console.error('Failed to notify client:', error);
            return false;
        }
    });
}

// ================== Middleware ==================
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== Routes ==================
app.get('/qrcode', async (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });

    try {
        if (!client) {
            return res.json({ status: 'initializing', qrCode: null });
        }

        if (clientStatus === 'ready') {
            return res.json({ status: 'authenticated', qrCode: null });
        }

        if (qrCodeData) {
            return res.json({ status: 'waiting_for_scan', qrCode: qrCodeData });
        }

        res.json({ status: clientStatus, qrCode: null });
    } catch (error) {
        console.error('QR code endpoint error:', error);
        res.status(500).json({ status: 'error' });
    }
});

// Update the refresh handler to respect cooldown
app.post('/refresh-qr', async (req, res) => {
    try {
        const now = Date.now();
        const timeSinceLastAttempt = now - lastConnectionAttempt;
        
        if (timeSinceLastAttempt < CONNECTION_COOLDOWN) {
            const waitTime = Math.ceil((CONNECTION_COOLDOWN - timeSinceLastAttempt)/1000);
            return res.status(429).json({ 
                error: `Please wait ${waitTime} seconds before refreshing`,
                waitTime 
            });
        }

        console.log('🔄 Manual QR refresh requested');
        await initializeClient();
        res.json({ status: 'refresh_initiated' });
    } catch (error) {
        console.error('❌ Refresh failed:', error);
        res.status(500).json({ error: 'Refresh failed' });
    }
});

// ================== SSE Endpoints ==================
function setupSSE(res) {
    // Set headers for SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
    });

    // Send initial heartbeat
    res.write('retry: 1000\n\n');
    
    return res;
}

// Update status endpoint
app.get('/status', (req, res) => {
    const clientRes = setupSSE(res);
    
    // Send current status directly
    clientRes.write(`data: ${clientStatus}\n\n`);
    statusClients.push(clientRes);
    
    req.on('close', () => {
        statusClients = statusClients.filter(c => c !== clientRes);
    });
});

// Update other SSE endpoints similarly
app.get('/progress', (req, res) => {
    const clientRes = setupSSE(res);
    progressClients.push(clientRes);
    req.on('close', () => {
        progressClients = progressClients.filter(c => c !== clientRes);
    });
});

app.get('/message-status', (req, res) => {
    const clientRes = setupSSE(res);
    messageStatusClients.push(clientRes);
    req.on('close', () => {
        messageStatusClients = messageStatusClients.filter(c => c !== clientRes);
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
            try {
                await client.logout();
            } catch (error) {
                console.warn('Logout warning:', error);
            }
            
            try {
                await client.destroy();
            } catch (error) {
                console.warn('Destroy warning:', error);
            }
            
            client = null;
        }
        
        qrCodeData = null;
        clientStatus = 'initializing';
        notifyClients('initializing');
        
        // Reset retry count before reinitializing
        initRetryCount = 0;
        setTimeout(initializeClient, 2000);
        
        res.json({ status: 'signed_out' });
    } catch (error) {
        console.error('Signout error:', error);
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