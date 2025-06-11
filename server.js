const express = require('express');
const cors = require('cors');
const axios = require('axios');
const csv = require('csv-parser');
const { parse } = require('csv-parse/sync');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// LOGGING MIDDLEWARE - Per debug
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    if (req.method === 'POST' && req.body) {
        console.log('Body:', JSON.stringify(req.body, null, 2));
    }
    next();
});

// Configurazione
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'loft-73.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const BACK_IN_STOCK_TOKEN = process.env.BACK_IN_STOCK_TOKEN || '7ae5687e26fc02f7792bb75eb88f0e9e';

// Cache per i dati Back in Stock
let backInStockCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuti

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        services: {
            backInStock: !!BACK_IN_STOCK_TOKEN,
            shopify: !!SHOPIFY_ACCESS_TOKEN
        },
        cache: {
            hasData: !!backInStockCache,
            lastUpdate: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null
        }
    });
});

// Endpoint per recuperare le richieste Back in Stock
app.get('/api/back-in-stock-requests', async (req, res) => {
    try {
        console.log('Fetching Back in Stock requests...');
        
        // Controlla se forzare il refresh
        const forceRefresh = req.query.refresh === 'true';
        
        // Usa cache se disponibile e non scaduta
        if (!forceRefresh && backInStockCache && cacheTimestamp && 
            (Date.now() - cacheTimestamp) < CACHE_DURATION) {
            console.log('Returning cached data');
            return res.json({
                success: true,
                data: backInStockCache,
                format: 'csv',
                timestamp: new Date(cacheTimestamp).toISOString(),
                source: 'cache'
            });
        }
        
        // Altrimenti fetch nuovi dati
        console.log('Fetching fresh data from Back in Stock API...');
        let response;
        try {
            // Metodo 1: Bearer Token
            response = await axios.get('https://app.backinstock.org/api/v1/variants.csv', {
                headers: {
                    'Authorization': `Bearer ${BACK_IN_STOCK_TOKEN}`,
                    'Accept': 'text/csv',
                    'User-Agent': 'Loft73-Dashboard/1.0'
                },
                timeout: 30000
            });
            console.log('Metodo 1 (Bearer) success');
        } catch (error) {
            console.log('Metodo 1 fallito:', error.message);
            console.log('Provo metodo 2...');
            
            // Metodo 2: Token in URL
            const url = `https://${BACK_IN_STOCK_TOKEN}@app.backinstock.org/api/v1/variants.csv`;
            response = await axios.get(url, {
                headers: {
                    'Accept': 'text/csv',
                    'User-Agent': 'Loft73-Dashboard/1.0'
                },
                timeout: 30000
            });
            console.log('Metodo 2 (URL token) success');
        }
        
        if (response.data) {
            console.log('Dati ricevuti da Back in Stock, lunghezza:', response.data.length);
            
            // Aggiorna cache
            backInStockCache = response.data;
            cacheTimestamp = Date.now();
            
            // Invia il CSV
            res.json({
                success: true,
                data: response.data,
                format: 'csv',
                timestamp: new Date().toISOString(),
                source: 'back-in-stock-api'
            });
        } else {
            throw new Error('Nessun dato ricevuto dall\'API');
        }
        
    } catch (error) {
        console.error('Errore nel recupero dati Back in Stock:', error.message);
        
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Headers:', error.response.headers);
            console.error('Data:', error.response.data);
        }
        
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.message,
            details: error.response?.data || 'Errore sconosciuto'
        });
    }
});

// Webhook endpoint per Back in Stock - CON VARI PATH POSSIBILI
// Prova diversi path che Back in Stock potrebbe usare
const webhookPaths = [
    '/api/webhook/back-in-stock',
    '/api/webhooks/back-in-stock',
    '/webhook/back-in-stock',
    '/webhooks/back-in-stock',
    '/api/webhook',
    '/api/webhooks',
    '/webhook',
    '/webhooks'
];

// Registra l'handler per tutti i possibili path
webhookPaths.forEach(path => {
    app.post(path, (req, res) => {
        console.log(`=== WEBHOOK RICEVUTO SU ${path} ===`);
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Body:', JSON.stringify(req.body, null, 2));
        
        try {
            // Invalida cache quando arriva un nuovo webhook
            if (req.body.topic === 'notification/created' || 
                req.body.topic === 'notification/sent' ||
                req.body.notification_id || 
                req.body.product) {
                console.log('Invalidating cache due to webhook');
                backInStockCache = null;
                cacheTimestamp = null;
            }
            
            // Risposta 200 OK per confermare ricezione
            res.status(200).json({ 
                success: true, 
                message: 'Webhook received successfully',
                path: path,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            console.error('Errore processando webhook:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
});

// Endpoint Shopify per disponibilità prodotti
app.post('/api/shopify/products-availability', async (req, res) => {
    try {
        const { products } = req.body;
        
        if (!products || !Array.isArray(products)) {
            return res.status(400).json({
                success: false,
                error: 'Lista prodotti mancante o invalida'
            });
        }

        if (!SHOPIFY_ACCESS_TOKEN) {
            return res.status(500).json({
                success: false,
                error: 'Shopify Access Token non configurato'
            });
        }

        console.log(`Ricerca disponibilità per ${products.length} prodotti...`);

        // Crea mappa dei prodotti CSV per ricerca veloce
        const csvProductMap = new Map();
        products.forEach(p => {
            const key = p.name.toLowerCase().trim();
            csvProductMap.set(key, p);
        });

        const results = [];
        const shopifyUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/products.json`;
        let nextPageUrl = shopifyUrl;
        let totalProducts = 0;

        // Pagina attraverso tutti i prodotti Shopify
        while (nextPageUrl) {
            try {
                const response = await axios.get(nextPageUrl, {
                    headers: {
                        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    params: nextPageUrl === shopifyUrl ? {
                        limit: 250,
                        fields: 'id,title,variants,images'
                    } : undefined
                });

                const shopifyProducts = response.data.products;
                totalProducts += shopifyProducts.length;

                // Match prodotti
                for (const shopifyProduct of shopifyProducts) {
                    const shopifyTitle = shopifyProduct.title.toLowerCase().trim();
                    
                    // Cerca match esatto o parziale
                    for (const [csvKey, csvProduct] of csvProductMap) {
                        if (shopifyTitle.includes(csvKey) || csvKey.includes(shopifyTitle)) {
                            let totalAvailable = 0;
                            
                            // Calcola disponibilità totale
                            if (shopifyProduct.variants) {
                                shopifyProduct.variants.forEach(variant => {
                                    totalAvailable += variant.inventory_quantity || 0;
                                });
                            }

                            results.push({
                                csvProduct: csvProduct,
                                shopifyProduct: {
                                    id: shopifyProduct.id,
                                    title: shopifyProduct.title,
                                    variants: shopifyProduct.variants,
                                    images: shopifyProduct.images
                                },
                                available: totalAvailable
                            });
                            
                            // Rimuovi dalla mappa per evitare duplicati
                            csvProductMap.delete(csvKey);
                            break;
                        }
                    }
                }

                // Controlla se c'è una pagina successiva
                const linkHeader = response.headers.link;
                nextPageUrl = null;
                
                if (linkHeader) {
                    const links = linkHeader.split(',');
                    for (const link of links) {
                        if (link.includes('rel="next"')) {
                            const match = link.match(/<(.+?)>/);
                            if (match) {
                                nextPageUrl = match[1];
                            }
                        }
                    }
                }

            } catch (error) {
                console.error('Errore nel recupero prodotti Shopify:', error.message);
                break;
            }
        }

        console.log(`Analizzati ${totalProducts} prodotti Shopify`);
        console.log(`Trovati ${results.length} match`);

        res.json({
            success: true,
            results: results,
            stats: {
                totalCsvProducts: products.length,
                totalShopifyProducts: totalProducts,
                matchedProducts: results.length,
                unmatchedProducts: csvProductMap.size,
                matchRate: ((results.length / products.length) * 100).toFixed(2)
            }
        });

    } catch (error) {
        console.error('Errore nella ricerca disponibilità:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Endpoint per forzare refresh cache
app.post('/api/refresh-cache', (req, res) => {
    console.log('Forced cache refresh requested');
    backInStockCache = null;
    cacheTimestamp = null;
    res.json({ 
        success: true, 
        message: 'Cache cleared',
        timestamp: new Date().toISOString()
    });
});

// Catch-all per richieste non gestite - DEVE ESSERE L'ULTIMO
app.all('*', (req, res) => {
    console.log('=== RICHIESTA NON GESTITA ===');
    console.log('Method:', req.method);
    console.log('Path:', req.path);
    console.log('URL:', req.url);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    
    res.status(404).json({ 
        error: 'Endpoint not found', 
        path: req.path,
        method: req.method,
        message: 'Verifica che l\'URL del webhook sia corretto'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n=== SERVER AVVIATO ===`);
    console.log(`Porta: ${PORT}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('\nConfigurazione:');
    console.log('- Shopify Store:', SHOPIFY_STORE_URL);
    console.log('- Shopify Token:', SHOPIFY_ACCESS_TOKEN ? 'Configurato ✓' : 'MANCANTE ✗');
    console.log('- Back in Stock Token:', BACK_IN_STOCK_TOKEN ? 'Configurato ✓' : 'MANCANTE ✗');
    console.log('- Cache Duration:', CACHE_DURATION / 1000, 'secondi');
    console.log('\nWebhook endpoints registrati:');
    webhookPaths.forEach(path => console.log(`  - POST ${path}`));
    console.log('\n===================\n');
});
