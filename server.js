const WebSocket = require('ws');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const express = require('express');
const path = require('path');
const http = require('http');

// Global error handlers to prevent crashes
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

// --- CONFIG ---
const HTTP_PORT = process.env.PORT || 3000;
const WIDTH = 1280;
const HEIGHT = 720;

// --- LOCATE BROWSER ---
const paths = [
    // Environment variable (set by Docker/Koyeb)
    process.env.CHROME_BIN,
    // Linux paths
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
].filter(Boolean);

let exePath = null;
for (const p of paths) {
    try {
        if (fs.existsSync(p)) {
            exePath = p;
            break;
        }
    } catch(e) {}
}

let browser;
let pages = []; // { id, page }
let activePageId = null;
let allConnections = []; // Track all WebSocket connections
let lastFrame = null; // Global frame cache
let screenshotTimer = null; // Single global screenshot timer

function generateId() { return Math.random().toString(36).substr(2, 9); }

async function broadcastTabs(wsToSkip = null) {
    const tabsData = await Promise.all(pages.map(async (p) => {
        let title = "Nebula";
        let url = 'about:blank';
        try { 
            title = await p.page.title(); 
            url = p.page.url();
        } catch(e){}
        if (!title || title.length === 0) title = "Nebula";
        return { id: p.id, title: title, url: url };
    }));

    // Broadcast to all connected clients
    allConnections.forEach(ws => {
        if (ws !== wsToSkip && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tabs-update', tabs: tabsData, activeId: activePageId }));
        }
    });
}

async function createNewTab(ws, url = 'about:blank') {
    const newPage = await browser.newPage();
    const id = generateId();
    await newPage.setViewport({ width: WIDTH, height: HEIGHT });
    
    if (url === 'about:blank') {
        await newPage.goto('about:blank');
    } else {
        await newPage.goto(url);
    }

    pages.push({ id, page: newPage });
    activePageId = id;
    broadcastTabs();
    return newPage;
}

(async () => {
    if (!exePath) { 
        console.log("❌ Browser not found at:", paths);
        console.log("❌ Please install Chrome/Chromium or Edge");
        process.exit(1); 
    }
    console.log(`🌌 Nebula Engine starting on port ${HTTP_PORT}...`);
    console.log(`📍 Using browser: ${exePath}`);

    browser = await puppeteer.launch({
        executablePath: exePath,
        headless: "new",
        args: [`--window-size=${WIDTH},${HEIGHT}`, '--no-sandbox', '--disable-infobars']
    });

    // Setup Express server to serve the interface
    const app = express();
    const server = http.createServer(app);
    
    // Add CORS and proper headers
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Connection', 'Upgrade');
        next();
    });
    
    app.use(express.static(path.join(__dirname)));
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'interface.html'));
    });

    // Setup WebSocket on the same HTTP server
    const wss = new WebSocket.Server({ server });

    // Start GLOBAL screenshot streaming (runs once for all connections)
    function startGlobalStreaming() {
        if (screenshotTimer) clearInterval(screenshotTimer);
        
        let frameCount = 0;
        screenshotTimer = setInterval(async () => {
            if (pages.length === 0) return;
            
            const activeObj = pages.find(p => p.id === activePageId);
            if (!activeObj || activeObj.page.isClosed()) return;
            
            // Skip frames - only capture every 3rd frame (3.3 FPS, very low CPU)
            if (frameCount++ % 3 !== 0) return;
            
            try {
                const data = await Promise.race([
                    activeObj.page.screenshot({ 
                        encoding: 'base64', type: 'jpeg', quality: 35 
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 2000))
                ]);
                
                lastFrame = data; // Cache the frame
                
                // Broadcast to ALL connected clients
                allConnections.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        try {
                            client.send(JSON.stringify({ type: 'frame', data }));
                        } catch (e) {}
                    }
                });
            } catch (e) {
                // Silently ignore screenshot errors
            }
        }, 100);
    }

    wss.on('connection', async (ws) => {
        console.log("Interface Connected.");
        allConnections.push(ws);
        
        if (pages.length === 0) await createNewTab(ws); // Start with blank tab
        else broadcastTabs();
        
        // Send cached frame immediately
        if (lastFrame) {
            try {
                ws.send(JSON.stringify({ type: 'frame', data: lastFrame }));
            } catch (e) {}
        }
        
        // Start global streaming if not running
        if (!screenshotTimer) startGlobalStreaming();

        // COMMANDS
        ws.on('message', async (msg) => {
            const m = JSON.parse(msg);
            const activeObj = pages.find(p => p.id === activePageId);
            const page = activeObj ? activeObj.page : null;

            if (m.type === 'navigate') {
                let url = m.data;
                if (!url.startsWith('http')) {
                    if(url.includes('.')) url = 'https://' + url;
                    else url = 'https://www.google.com/search?q=' + url;
                }
                if (page) { 
                    try {
                        await Promise.race([
                            page.goto(url, { waitUntil: 'domcontentloaded' }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), 15000))
                        ]);
                    } catch (e) {
                        // Silently handle navigation errors
                    }
                    broadcastTabs(); 
                }
            }

            if (m.type === 'click' && page) {
                try { await page.mouse.click(m.x, m.y); } catch(e){}
            }

            if (m.type === 'type' && page) {
                try { await page.keyboard.type(m.data); } catch(e){}
            }

            if (m.type === 'keydown' && page) {
                try { await page.keyboard.press(m.data); } catch(e){}
            }

            if (m.type === 'keyup' && page) {
                try { await page.keyboard.press(m.data); } catch(e){}
            }

            if (m.type === 'new-tab') {
                await createNewTab(ws);
                broadcastTabs();
            }

            if (m.type === 'switch-tab') {
                activePageId = m.data;
                broadcastTabs();
            }

            if (m.type === 'close-tab') {
                const idx = pages.findIndex(p => p.id === m.data);
                if (idx > -1) {
                    try {
                        if (!pages[idx].page.isClosed()) {
                            await pages[idx].page.close();
                        }
                    } catch (e) {
                        // Page already closed or error closing, just remove it
                    }
                    pages.splice(idx, 1);
                    if (pages.length > 0) activePageId = pages[pages.length - 1].id;
                    else await createNewTab(ws); // Don't allow 0 tabs
                    broadcastTabs();
                }
            }

            if (m.type === 'back' && page) {
                try {
                    await Promise.race([
                        page.goBack(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Go back timeout')), 10000))
                    ]);
                } catch (e) {}
                broadcastTabs();
            }
            if (m.type === 'forward' && page) {
                try {
                    await Promise.race([
                        page.goForward(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Go forward timeout')), 10000))
                    ]);
                } catch (e) {}
                broadcastTabs();
            }
            if (m.type === 'reload' && page) {
                try {
                    await Promise.race([
                        page.reload(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Reload timeout')), 10000))
                    ]);
                } catch (e) {}
                broadcastTabs();
            }
        });

        ws.on('close', () => {
            allConnections = allConnections.filter(c => c !== ws);
            // Stop global streaming if no clients connected
            if (allConnections.length === 0 && screenshotTimer) {
                clearInterval(screenshotTimer);
                screenshotTimer = null;
            }
        });
    });

    server.listen(HTTP_PORT, '0.0.0.0', () => {
        console.log(`✅ Server running at http://0.0.0.0:${HTTP_PORT}`);
    });
})();