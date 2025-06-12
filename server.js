const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configurazione
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'loft-73.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// IMPORTANTE: Array in memoria per salvare le richieste dal webhook
let backInStockRequests = [];
let lastWebhookReceived = null;

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        services: {
            shopify: !!SHOPIFY_ACCESS_TOKEN,
            webhook: true
        },
        data: {
            totalRequests: backInStockRequests.length,
            lastWebhook: lastWebhookReceived
        }
    });
});

// WEBHOOK ENDPOINT - Riceve le notifiche da Back in Stock
app.post('/api/webhook/back-in-stock', (req, res) => {
    console.log('=== WEBHOOK RICEVUTO DA BACK IN STOCK ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    try {
        const webhookData = req.body;
        lastWebhookReceived = new Date().toISOString();
        
        // Estrai i dati dal webhook e formattali per la dashboard
        const formattedRequest = {
            // Campi principali
            notification_id: webhookData.notification_id || '',
            sku: webhookData.product?.sku || '',
            product_name: webhookData.product?.product_title || '',
            description: webhookData.product?.product_title || '', // Alias per compatibilità
            variant_id: webhookData.product?.variant_id || '',
            variant_title: webhookData.product?.variant_title || '',
            
            // Dati cliente
            email: webhookData.customer?.email || '',
            customer_email: webhookData.customer?.email || '', // Alias
            first_name: webhookData.customer?.first_name || '',
            last_name: webhookData.customer?.last_name || '',
            
            // Quantità e date
            requests: webhookData.quantity_required || 1,
            quantity: webhookData.quantity_required || 1, // Alias
            sent: 0, // Default non inviato
            created_at: webhookData.created_at || new Date().toISOString(),
            last_added: webhookData.created_at || new Date().toISOString(), // Alias
            
            // Opzioni prodotto (se disponibili)
            option_1: webhookData.product?.option1 || '',
            option_2: webhookData.product?.option2 || '',
            
            // Prezzo (se disponibile)
            unit_price: webhookData.product?.price || 0,
            
            // Dati originali completi per debug
            _original: webhookData
        };
        
        // ==========================================
        // FIX PER ESTRARRE VARIANTI DAL NOME/SKU
        // ==========================================
        
        // Lista completa dei colori possibili
        const colorPatterns = [
            'TORTORA', 'NERO', 'BIANCO', 'GRIGIO', 'BLU', 'ROSSO', 'VERDE', 
            'BEIGE', 'MARRONE', 'GIALLO', 'ARANCIONE', 'VIOLA', 'ROSA',
            'CELESTE', 'NAVY', 'BORDEAUX', 'CAMMELLO', 'CIOCCOLATO', 'PANNA',
            'ANTRACITE', 'KAKI', 'MILITARE', 'SABBIA', 'TAUPE', 'FANGO',
            'CIPRIA', 'CORALLO', 'TURCHESE', 'PETROLIO', 'SENAPE', 'RUGGINE'
        ];
        
        // Se non ha variante, prova a estrarla dal nome prodotto o SKU
        if (!formattedRequest.variant_title || formattedRequest.variant_title === '') {
            console.log('Variante non trovata nel webhook, tento estrazione...');
            
            let variantFound = false;
            
            // Prima prova: cerca nel nome del prodotto
            if (formattedRequest.product_name) {
                const productNameUpper = formattedRequest.product_name.toUpperCase();
                
                for (const color of colorPatterns) {
                    if (productNameUpper.includes(color)) {
                        formattedRequest.variant_title = color;
                        formattedRequest.option_2 = color;
                        variantFound = true;
                        console.log(`Variante trovata nel nome prodotto: ${color}`);
                        break;
                    }
                }
            }
            
            // Seconda prova: cerca nello SKU
            if (!variantFound && formattedRequest.sku) {
                const skuUpper = formattedRequest.sku.toUpperCase();
                
                for (const color of colorPatterns) {
                    if (skuUpper.includes(color)) {
                        formattedRequest.variant_title = color;
                        formattedRequest.option_2 = color;
                        variantFound = true;
                        console.log(`Variante trovata nello SKU: ${color}`);
                        break;
                    }
                }
            }
            
            // Terza prova: estrai dal pattern comune "NOME - COLORE"
            if (!variantFound && formattedRequest.product_name) {
                const match = formattedRequest.product_name.match(/[-–]\s*([^-–]+)\s*$/);
                if (match) {
                    const potentialColor = match[1].trim();
                    formattedRequest.variant_title = potentialColor;
                    formattedRequest.option_2 = potentialColor;
                    variantFound = true;
                    console.log(`Variante estratta dal pattern: ${potentialColor}`);
                }
            }
            
            // Se ancora non trova nulla, usa Standard
            if (!variantFound) {
                formattedRequest.variant_title = 'Standard';
                formattedRequest.option_2 = 'Standard';
                console.log('Nessuna variante trovata, uso "Standard"');
            }
        }
        
        // Se option_2 è vuoto ma variant_title no, copia il valore
        if (!formattedRequest.option_2 && formattedRequest.variant_title) {
            formattedRequest.option_2 = formattedRequest.variant_title;
        }
        
        // ==========================================
        // FINE FIX VARIANTI
        // ==========================================
        
        // Aggiungi alla lista
        backInStockRequests.unshift(formattedRequest); // Aggiungi all'inizio (più recenti prima)
        
        console.log(`✅ Richiesta salvata! Totale richieste: ${backInStockRequests.length}`);
        console.log(`   Prodotto: ${formattedRequest.product_name}`);
        console.log(`   Variante: ${formattedRequest.variant_title}`);
        
        // Rispondi 200 OK per confermare ricezione
        res.status(200).json({ 
            success: true, 
            message: 'Webhook received and processed',
            timestamp: new Date().toISOString(),
            totalRequests: backInStockRequests.length
        });
        
    } catch (error) {
        console.error('❌ Errore processando webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET REQUESTS - Restituisce le richieste salvate dai webhook
app.get('/api/back-in-stock-requests', (req, res) => {
    console.log('=== RICHIESTA DATI BACK IN STOCK ===');
    console.log(`Restituendo ${backInStockRequests.length} richieste`);
    
    // Restituisci i dati nel formato che la dashboard si aspetta
    res.json({
        success: true,
        data: backInStockRequests,
        format: 'json',
        source: 'webhook-memory',
        timestamp: new Date().toISOString(),
        count: backInStockRequests.length
    });
});

// CONTEGGIO RICHIESTE - Per badge notifiche
app.get('/api/back-in-stock-requests/count', (req, res) => {
    res.json({
        success: true,
        count: backInStockRequests.length,
        lastUpdate: lastWebhookReceived
    });
});

// CLEAR DATA - Solo per testing, rimuovi in produzione
app.delete('/api/back-in-stock-requests/clear', (req, res) => {
    const previousCount = backInStockRequests.length;
    backInStockRequests = [];
    
    console.log(`🗑️ Cancellati ${previousCount} record`);
    
    res.json({
        success: true,
        message: `Cleared ${previousCount} requests`,
        timestamp: new Date().toISOString()
    });
});

// ENDPOINT SHOPIFY - Per sincronizzazione disponibilità prodotti
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

// DATI DI TEST - Endpoint per inviare webhook di test
app.post('/api/test/send-webhook', (req, res) => {
    const testData = {
        notification_id: Date.now(),
        product: {
            product_title: "LOFT.73 - COMPLETO ARIELE - TORTORA",
            sku: "ARIELE-P5D7311-TORTORA",
            variant_id: "12345",
            variant_title: "", // Simuliamo il problema: variante vuota
            option1: "M",
            option2: "", // Anche questo vuoto
            price: 289.00
        },
        customer: {
            email: "test@example.com",
            first_name: "Mario",
            last_name: "Rossi"
        },
        quantity_required: 1,
        created_at: new Date().toISOString()
    };
    
    // Simula l'invio del webhook a se stesso
    axios.post(`http://localhost:${PORT}/api/webhook/back-in-stock`, testData)
        .then(() => {
            res.json({ success: true, message: 'Test webhook sent', data: testData });
        })
        .catch(error => {
            res.status(500).json({ success: false, error: error.message });
        });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Server avviato sulla porta ${PORT}`);
    console.log('\n📋 Endpoints disponibili:');
    console.log(`   POST   /api/webhook/back-in-stock     - Riceve webhook da Back in Stock`);
    console.log(`   GET    /api/back-in-stock-requests    - Restituisce richieste salvate`);
    console.log(`   GET    /api/back-in-stock-requests/count - Conta richieste`);
    console.log(`   DELETE /api/back-in-stock-requests/clear - Pulisce dati (test)`);
    console.log(`   POST   /api/shopify/products-availability - Sincronizza con Shopify`);
    console.log(`   POST   /api/test/send-webhook         - Invia webhook di test`);
    console.log(`   GET    /api/health                    - Health check`);
    console.log('\n⚡ Sistema Webhook ATTIVO - I dati si accumulano automaticamente!');
    console.log(`📊 Richieste in memoria: ${backInStockRequests.length}`);
    
    if (!SHOPIFY_ACCESS_TOKEN) {
        console.log('\n⚠️  ATTENZIONE: Shopify Access Token non configurato!');
    }
});
