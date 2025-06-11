# Loft73 Inventory Server

Server API per la gestione dell'inventario e sincronizzazione con Shopify per Loft73.

## Funzionalità
- Sincronizzazione disponibilità prodotti con Shopify
- Integrazione Back in Stock (in sviluppo)
- API REST per dashboard inventario

## Endpoints
- `GET /api/health` - Health check
- `GET /api/back-in-stock-requests` - Richieste Back in Stock
- `POST /api/shopify/products-availability` - Disponibilità prodotti Shopify

## Setup
1. `npm install`
2. Crea file `.env` con le variabili necessarie
3. `npm start` per produzione o `npm run dev` per sviluppo

## Deploy
Hosted su Railway: https://loft73-webhook-server-production.up.railway.app
