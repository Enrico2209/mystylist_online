"use strict";

/**
 * Catalogo degli outfit, letto dal JSON prodotto dalla pipeline.
 *
 * In locale il JSON e le foto stanno nella cartella della pipeline e non
 * vengono copiati qui: sono 2,3 GB di immagini, e cambiano a ogni tornata di
 * generazione. Il server li legge da lì e li espone sotto /media.
 *
 * In produzione quella cartella non esiste. Allora il JSON si scarica da un
 * URL (OUTFITS_JSON_URL) e le foto le serve un CDN (MEDIA_BASE_URL): il
 * servizio resta leggero e non deve contenere 435 MB di immagini.
 *
 * Il database, in entrambi i casi, contiene solo ciò che è suo — chi ha
 * giudicato cosa. Il legame fra le due parti è matches.codice.
 */

const fs = require("fs");
const path = require("path");

const ASSETS_DIR = process.env.ASSETS_DIR
    ? path.resolve(process.env.ASSETS_DIR)
    : path.resolve(__dirname, "..", "..", "..", "nuvolari backend");

const FILE_JSON = process.env.OUTFITS_JSON || path.join(ASSETS_DIR, "outfits_ui.json");
const URL_JSON = process.env.OUTFITS_JSON_URL || null;
const PORT = process.env.PORT || 3001;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const BASE_MEDIA = (process.env.MEDIA_BASE_URL || `${PUBLIC_URL}/media`).replace(/\/+$/, "");

// Cartelle servite come statiche in locale: solo queste, non l'intera
// cartella della pipeline — lì dentro ci sono anche .env, parquet e script.
const CARTELLE_MEDIA = ["outfit_images", "outfit_thumbs", "nuvolari_full_organizzato"];

let documento = null;
let perCodice = new Map();

function urlMedia(relativo) {
    return relativo ? `${BASE_MEDIA}/${relativo}` : null;
}

/** Versione leggera: quella che basta a una card in lista. */
function sintesi(o) {
    return {
        codice: o.id,
        nome: o.nome,
        immagine: o.immagine,
        miniatura: o.miniatura,
        genere: o.genere,
        stile: o.stile,
        formalita: o.formalita,
        compatibilita: o.compatibilita,
        prezzo_totale: o.prezzo_totale,
        prezzo_completo: o.prezzo_completo,
        valuta: o.valuta,
        numero_capi: o.numero_capi,
        brand: o.brand,
    };
}

/** Le miniature sono file derivati (make_thumbs.py). In locale si controlla
 *  che esistano; dietro un CDN si dà per buono l'indirizzo, perché una
 *  verifica per ogni outfit sarebbero 151 richieste di rete all'avvio. */
function miniaturaDi(o) {
    if (process.env.MEDIA_BASE_URL) return urlMedia(`outfit_thumbs/${o.id}.webp`);
    const file = path.join(ASSETS_DIR, "outfit_thumbs", `${o.id}.webp`);
    return fs.existsSync(file) ? urlMedia(`outfit_thumbs/${o.id}.webp`) : urlMedia(o.immagine);
}

async function carica() {
    let testo;
    if (URL_JSON) {
        const risposta = await fetch(URL_JSON);
        if (!risposta.ok) {
            throw new Error(`Impossibile scaricare ${URL_JSON}: HTTP ${risposta.status}`);
        }
        testo = await risposta.text();
    } else {
        if (!fs.existsSync(FILE_JSON)) {
            throw new Error(
                `outfits_ui.json non trovato in ${FILE_JSON}.\n` +
                `In locale: generalo con "python3 build_ui_json.py" nella cartella della ` +
                `pipeline, o indica la cartella con ASSETS_DIR.\n` +
                `In produzione: imposta OUTFITS_JSON_URL.`);
        }
        testo = fs.readFileSync(FILE_JSON, "utf-8");
    }

    documento = JSON.parse(testo);

    // I percorsi nel JSON sono relativi (outfit_images/xxx.png): qui diventano
    // URL assoluti, così il browser li carica senza sapere dove stanno i file.
    for (const o of documento.outfit) {
        o.miniatura = miniaturaDi(o);
        o.immagine = urlMedia(o.immagine);
        for (const c of o.capi) {
            c.immagine = urlMedia(c.immagine);
            c.immagini = (c.immagini || []).map(urlMedia);
        }
    }

    perCodice = new Map(documento.outfit.map((o) => [o.id, o]));
    return documento;
}

function stato() {
    if (!documento) throw new Error("Catalogo non caricato: chiama carica() all'avvio.");
    return documento;
}

module.exports = {
    ASSETS_DIR,
    CARTELLE_MEDIA,
    FILE_JSON,
    ORIGINE: URL_JSON || FILE_JSON,
    carica,
    sintesi,
    tutti: () => stato().outfit,
    codici: () => stato().outfit.map((o) => o.id),
    perId: (codice) => perCodice.get(codice),
    filtri: () => stato().filtri,
    generatoIl: () => stato().generato_il,
};
