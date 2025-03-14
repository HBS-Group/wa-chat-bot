const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fileUpload = require('express-fileupload');
const XLSX = require('xlsx'); // Add XLSX for Excel file parsing
const fs = require('fs');

const app = express();
const port = 3000;

// Middleware for file uploads
app.use(fileUpload());
app.use(express.static('public'));
app.use(express.json()); // parse application/json
app.use(express.urlencoded({ extended: true })); // parse URL-encoded data

let client = null;
let qrCodeData = null;
let progressClients = []; // added for SSE progress updates
let clientStatus = false; // new: holds client state
let statusClients = [];  // new: SSE clients for status updates
let resultClients = [];  // Added for result updates SSE
let messageStatusClients = []; // Add this near the top with other SSE client arrays

// Add initialization lock to prevent multiple simultaneous initializations
let isInitializing = false;
let initRetryCount = 0;
const MAX_RETRIES = 3;

// Add new function to check real authentication state
async function checkAuthState() {
    if (!client) return false;
    try {
        const state = await client.getState();
        return state === 'CONNECTED';
    } catch (error) {
        console.error('Auth state check failed:', error);
        return false;
    }
}

// Function to initialize client
async function initializeClient() {
    if (isInitializing) {
        console.log('Client initialization already in progress...');
        return;
    }

    isInitializing = true;
    try {
        if (client) {
            console.log('Cleaning up old client...');
            try {
                await client.destroy();
            } catch (err) {
                console.error('Error destroying old client:', err);
            }
            client = null;
        }

        clientStatus = 'initializing';
        qrCodeData = null;

        console.log('Initializing new client... Attempt:', initRetryCount + 1);
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'whatsapp-bot',
                dataPath: './.wwebjs_auth' // Ensure the auth data path is set correctly
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            }
        });

        let qrRetryCount = 0;
        client.on('qr', async (qr) => {
            console.log('New QR code received, attempt:', qrRetryCount + 1);
            try {
                qrCodeData = await qrcode.toDataURL(qr);
                clientStatus = 'scan_qr';
                statusClients.forEach(client => {
                    client.write(`data: scan_qr\n\n`);
                });
                qrRetryCount++;
            } catch (err) {
                console.error('QR Generation Error:', err);
                qrCodeData = null;
            }
        });

        client.on('ready', async () => {
            console.log('Client is ready!');
            const isAuthenticated = await checkAuthState();
            if (isAuthenticated) {
                clientStatus = 'ready';
                initRetryCount = 0;
                statusClients.forEach(client => client.write(`data: ready\n\n`));
            } else {
                console.log('False ready state detected, reinitializing...');
                await initializeClient();
            }
        });

        client.on('auth_failure', async (err) => {
            console.log('Auth failed:', err);
            clientStatus = false;
            initRetryCount++;
            await initializeClient();
        });

        client.on('disconnected', async (reason) => {
            console.log('Client disconnected:', reason);
            clientStatus = false;
            qrCodeData = null;
            initRetryCount++;
            await initializeClient();
        });

        await client.initialize();

    } catch (error) {
        console.error('Initialization Error:', error);
        clientStatus = 'error';
        statusClients.forEach(client => client.write(`data: error\n\n`));
    } finally {
        isInitializing = false;
    }
}

// Function to format phone number for WhatsApp
function formatPhoneNumber(number) {
    const cleaned = number.trim().replace('+', '');
    return `${cleaned}@c.us`;
}

// Function to delay between messages
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Add this function to check client state
async function ensureClientReady() {
    if (!client || !clientStatus || clientStatus !== 'ready') {
        throw new Error('WhatsApp client is not ready. Please scan the QR code first.');
    }

    // Add an additional check to verify the client's state
    try {
        await client.getState();
    } catch (error) {
        console.error('Client state check failed:', error);
        throw new Error('WhatsApp connection is not stable. Please try reconnecting.');
    }
}

// Replace the existing QR code endpoint
app.get('/qrcode', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Content-Type': 'application/json',
    });
    
    if (!client) {
        return res.json({ status: 'initializing', qrCode: null });
    }
    
    if (clientStatus === 'ready') {
        return res.json({ status: 'authenticated', qrCode: null });
    }
    
    if (qrCodeData) {
        return res.json({ status: 'waiting_for_scan', qrCode: qrCodeData });
    }
    
    res.json({ status: 'loading', qrCode: null });
});

// Update the refresh endpoint to handle initialization properly
app.post('/refresh-qr', async (req, res) => {
    try {
        console.log('Manual QR refresh requested');
        initRetryCount = 0; // Reset retry count for manual refresh
        await initializeClient();
        res.json({ status: 'refresh_initiated' });
    } catch (error) {
        console.error('Refresh Error:', error);
        res.status(500).json({ error: 'Failed to refresh QR code' });
    }
});

// Add SSE endpoint for progress updates
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

// Add SSE endpoint for status updates
app.get('/status', (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    
    // Check real auth state before sending status
    checkAuthState().then(isAuthenticated => {
        const currentStatus = isAuthenticated ? 'ready' : (qrCodeData ? 'scan_qr' : 'not ready');
        res.write(`data: ${currentStatus}\n\n`);
        statusClients.push(res);
    });

    req.on('close', () => {
        statusClients = statusClients.filter(client => client !== res);
    });
});

// Add SSE endpoint for results updates
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

// Add new SSE endpoint for message status
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

// Update the send-messages endpoint
app.post('/send-messages', async (req, res) => {
    try {
        // Check client status first
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

        // Validate and format numbers
        const invalidNumbers = [];
        const validNumbers = [];

        json.forEach((row) => {
            const number = row['WhatsApp Number(with country code)'] || row.number; // fallback to row.number
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

        // Send messages to valid numbers with a delay
        const results = {
            success: [],
            failed: [],
            invalidNumbers,
        };

        // Update the message sending loop with better error handling
        for (let i = 0; i < validNumbers.length; i++) {
            const { formattedNumber, firstName, lastName } = validNumbers[i];
            const personalizedMessage = message
                .replace('{firstName}', firstName)
                .replace('{lastName}', lastName);

            try {
                // Verify client state before each message
                await ensureClientReady();
                
                // Add retry logic for sending messages
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
                        messageStatusClients.forEach(client => 
                            client.write(`data: ${JSON.stringify(statusData)}\n\n`)
                        );
                        results.success.push(formattedNumber);
                        break; // Break the retry loop on success
                    } catch (err) {
                        error = err;
                        retries--;
                        if (retries > 0) {
                            console.log(`Retrying message to ${formattedNumber}, ${retries} attempts remaining`);
                            await delay(2000); // Wait 2 seconds before retrying
                        }
                    }
                }

                if (retries === 0) {
                    throw error || new Error('Failed to send message after retries');
                }

            } catch (err) {
                console.error('Message send error:', err);
                const statusData = {
                    number: formattedNumber,
                    message: `Failed to send: ${err.message || 'Unknown error'}`,
                    success: false,
                    timestamp: new Date().toISOString(),
                    error: err.message || 'Unknown error'
                };
                messageStatusClients.forEach(client => 
                    client.write(`data: ${JSON.stringify(statusData)}\n\n`)
                );
                results.failed.push(formattedNumber);
            }

            // Add a longer delay between messages to prevent rate limiting
            const progress = Math.floor(((i + 1) / validNumbers.length) * 100);
            progressClients.forEach(client => client.write(`data: ${progress}\n\n`));
            
            // Use a minimum delay of 3 seconds between messages
            const messageDelay = Math.max(3000, req.body.interval ? parseFloat(req.body.interval) * 1000 : 3000);
            await delay(messageDelay);
        }

        // Send detailed response
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
        console.error('Send messages error:', error);
        res.status(500).json({
            error: 'Failed to send messages',
            message: error.message,
            details: error.stack
        });
    }
});

// Update the signout endpoint
app.post('/signout', async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
        }
        qrCodeData = null;
        clientStatus = false;
        statusClients.forEach(client => client.write(`data: not ready\n\n`));
        await initializeClient();
        res.json({ status: 'signed_out' });
    } catch (error) {
        console.error('Sign out error:', error);
        res.status(500).json({ error: 'Sign out failed', message: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message,
    });
});

// Initialize the client when server starts
initializeClient();

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});