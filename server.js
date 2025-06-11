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

// Configurazione
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'loft73-italy.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const BACK_IN_STOCK_TOKEN = process.env.BACK_IN_STOCK_TOKEN || '7ae5687e26fc02f7792bb75eb88f0e9e';

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        services: {
            backInStock: !!BACK_IN_STOCK_TOKEN,
            shopify: !!SHOPIFY_ACCESS_TOKEN
        }
    });
});

// Endpoint per recuperare le richieste Back in Stock
app.get('/api/back-in-stock-requests', async (req, res) => {
    try {
        console.log('Fetching Back in Stock requests...');
        
        // Opzione 1: API con token nell'header
        let response;
        try {
            response = await axios.get('https://app.backinstock.org/api/v1/variants.csv', {
                headers: {
                    'Authorization': `Bearer ${BACK_IN_STOCK_TOKEN}`,
                    'Accept': 'text/csv',
                    'User-Agent': 'Loft73-Dashboard/1.0'
                },
                timeout: 30000
            });
        } catch (error) {
            console.log('Metodo 1 fallito, provo metodo 2...');
            
            // Opzione 2: Token nell'URL (formato documentazione)
            const url = `https://${BACK_IN_STOCK_TOKEN}@app.backinstock.org/api/v1/variants.csv`;
            response = await axios.get(url, {
                headers: {
                    'Accept': 'text/csv',
                    'User-Agent': 'Loft73-Dashboard/1.0'
                },
                timeout: 30000
            });
        }
        
        if (response.data) {
            console.log('Dati ricevuti, lunghezza:', response.data.length);
            
            // Invia il CSV direttamente
            res.json({
                success: true,
                data: response.data,
                format: 'csv',
                timestamp: new Date().toISOString()
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

// Start server
app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
    console.log('Configurazione:');
    console.log('- Shopify Store:', SHOPIFY_STORE_URL);
    console.log('- Shopify Token:', SHOPIFY_ACCESS_TOKEN ? 'Configurato' : 'MANCANTE');
    console.log('- Back in Stock Token:', BACK_IN_STOCK_TOKEN ? 'Configurato' : 'MANCANTE');
});
