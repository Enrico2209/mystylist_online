require('dotenv').config();
const cors= require("cors");
const path = require("path");
const fs = require("fs");
const express = require('express');
const { Pool } = require('pg');
const outfits = require('./outfits');
const { cifra, verifica, emettiToken, richiedeAccesso } = require('./auth');
const rateLimit = require('express-rate-limit');

const app = express();
// Render (e ogni PaaS) mette un proxy davanti: senza questo express vede
// sempre lo stesso ip e il limite sui tentativi conterebbe tutti insieme.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Middleware per leggere il JSON
app.use(express.json());
// Le origini ammesse arrivano dall'ambiente: in locale la 5173 di Vite, in
// produzione il dominio del frontend. Elencarle è il punto — con origin:"*"
// qualunque pagina aperta dal browser dello stilista potrebbe chiamare l'API.
const ORIGINI = (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: ORIGINI, credentials: true }));
// Inizializzazione del Pool usando la stringa di connessione di Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necessario per la connessione sicura a Neon
    }
});

// Test della connessione all'avvio
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Errore di connessione a Neon:', err.stack);
    }
    console.log('Connesso con successo al database Neon!');
    release();
});

// --- catalogo degli outfit ---------------------------------------------
// Caricato una volta all'avvio: è un file di 600 KB, rileggerlo a ogni
// richiesta non aggiunge niente. Dopo una nuova tornata di immagini si
// rigenera il JSON e si riavvia il server (oppure POST /api/ricarica).
// Il caricamento è asincrono perché in produzione il JSON arriva da un URL:
// il server si mette in ascolto solo dopo, altrimenti le prime richieste
// troverebbero un catalogo vuoto e risponderebbero liste vuote senza errori.
async function avvia() {
    await outfits.carica();
    console.log(`Catalogo: ${outfits.codici().length} outfit da ${outfits.ORIGINE}`);
    montaMedia();
    app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
}

// Le foto: solo le cartelle degli asset, non tutta la cartella della
// pipeline (contiene .env, parquet, script), e solo file immagine.
const soloImmagini = (req, res, next) =>
    /\.(jpe?g|png|webp|avif)$/i.test(req.path) ? next() : res.sendStatus(404);

function montaMedia() {
    // Con MEDIA_BASE_URL le foto le serve un CDN e qui non c'è niente da
    // montare: su Render la cartella della pipeline non esiste proprio.
    if (process.env.MEDIA_BASE_URL) {
        console.log(`Foto servite da ${process.env.MEDIA_BASE_URL}`);
        return;
    }
    for (const cartella of outfits.CARTELLE_MEDIA) {
        const percorso = path.join(outfits.ASSETS_DIR, cartella);
        if (!fs.existsSync(percorso)) {
            console.warn(`Cartella foto assente, non montata: ${percorso}`);
            continue;
        }
        app.use(`/media/${cartella}`, soloImmagini,
            express.static(percorso, {
                maxAge: '7d',   // le foto non cambiano mai a parità di nome
                fallthrough: false,
            }));
    }
}

/** Errore leggibile quando il seed non è ancora stato lanciato. */
function erroreDb(res, errore) {
    console.error(errore);
    if (errore.code === '42703') {   // undefined_column
        return res.status(500).json({
            errore: "La tabella matches non ha la colonna 'codice'. " +
                    "Lancia: node seed_outfits.js"
        });
    }
    res.status(500).json({ errore: errore.message });
}

// Con l'API pubblica il login è l'unica porta aperta senza token: senza un
// limite si possono provare password all'infinito. Dieci tentativi ogni
// quarto d'ora sono larghi per una persona che scrive male la password, e
// stretti per chi le prova a macchina.
const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    // Su Render la richiesta passa da un proxy: senza questo il conteggio
    // sarebbe su un unico ip e bloccherebbe tutti insieme.
    message: {errore: "Troppi tentativi di accesso. Riprova fra un quarto d'ora."},
});

app.post("/api/login", limiteLogin, async(req, res)=>{
    const {username, password}= req.body;
    try{
        const result= await pool.query(
            `SELECT id, username, password FROM users WHERE username=$1`, [username]);
        const utente = result.rows[0];
        const esito = utente ? await verifica(password, utente.password) : false;

        if (!esito) {
            // Stesso messaggio per utente inesistente e password sbagliata:
            // distinguerli direbbe a un estraneo quali username esistono.
            return res.status(401).json({errore: "Utente o password non corretti."});
        }

        // Password ancora in chiaro in tabella: la si sostituisce con l'hash
        // al primo accesso riuscito, così la migrazione avviene da sé senza
        // chiedere a nessuno di reimpostare la password.
        if (esito.daMigrare) {
            await pool.query(`UPDATE users SET password=$1 WHERE id=$2`,
                             [await cifra(password), utente.id]);
            console.log(`Password di ${utente.username} convertita in hash.`);
        }

        res.json({token: emettiToken(utente), utente: {id: utente.id, username: utente.username}});
    }catch(errore){
        erroreDb(res, errore);
    }

});

app.post("/api/revisionare", richiedeAccesso, async(req, res)=>{
    const iduser = req.utente.id;
    const query= `SELECT m.id, m.codice FROM matches m
                  WHERE m.codice IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM user_data u
                                    WHERE u.id_match = m.id
                                      AND u.stato = 'giudicato'
                                      AND u.id_user = $1)`;
    try{
        const result= await pool.query(query, [iduser]);
        res.json(conOutfit(result.rows));
    }catch(errore){
        erroreDb(res, errore);
    }
});


app.post("/api/giudicato", richiedeAccesso, async(req, res)=>{
    const iduser = req.utente.id;
    const query= `SELECT u.id_match, u.responso, u.commento, u.motivi, m.codice
                  FROM user_data u JOIN matches m ON m.id = u.id_match
                  WHERE u.stato='giudicato' AND u.id_user=$1 AND m.codice = ANY($2)
                  ORDER BY u.id_data DESC`;
    try{
        const result= await pool.query(query, [iduser, outfits.codici()]);
        res.json(result.rows.map((r) => ({
            id: r.id_match, responso: r.responso,
            commento: r.commento, motivi: r.motivi || [],
            ...outfits.sintesi(outfits.perId(r.codice)),
        })));
    }catch(errore){
        erroreDb(res, errore);
    }
});

// Rimette un outfit già giudicato nella coda generale.
//
// La riga viene cancellata invece di essere marcata "non giudicato": con il
// verdetto se ne va anche il motivo del rifiuto, che senza il rifiuto non
// vuol dire più niente e falserebbe il conteggio dei difetti.
app.post("/api/annulla", richiedeAccesso, async(req, res)=>{
    const iduser = req.utente.id;
    const {id_match}=req.body;
    try{
        const r = await pool.query(
            `DELETE FROM user_data WHERE id_user=$1 AND id_match=$2`, [iduser, id_match]);
        if (!r.rowCount) {
            return res.status(404).json({errore: "Questo outfit non risulta revisionato."});
        }
        res.json({ok: true});
    }catch(errore){
        erroreDb(res, errore);
    }
});

// Registra il verdetto dello stilista. Ripetibile: se lo stesso outfit viene
// giudicato di nuovo il responso viene aggiornato, non duplicato.
app.post("/api/giudica", richiedeAccesso, async(req, res)=>{
    const iduser = req.utente.id;
    const {id_match, responso, commento, motivi}=req.body;
    if (!["si", "no"].includes(responso)) {
        return res.status(400).json({errore: "responso deve essere 'si' o 'no'"});
    }
    // Il commento è facoltativo: si suggerisce di scriverlo, non si obbliga.
    const testo = (commento || "").trim() || null;
    const elenco = Array.isArray(motivi) && motivi.length ? motivi : null;
    try{
        const gia = await pool.query(
            `SELECT id_data FROM user_data WHERE id_user=$1 AND id_match=$2`,
            [iduser, id_match]);
        if (gia.rowCount) {
            await pool.query(
                `UPDATE user_data SET stato='giudicato', responso=$1, commento=$2, motivi=$3
                 WHERE id_data=$4`,
                [responso, testo, elenco, gia.rows[0].id_data]);
        } else {
            await pool.query(
                `INSERT INTO user_data (id_user, id_match, stato, responso, commento, motivi)
                 VALUES ($1, $2, 'giudicato', $3, $4, $5)`,
                [iduser, id_match, responso, testo, elenco]);
        }
        res.json({ok: true});
    }catch(errore){
        erroreDb(res, errore);
    }
});

// I numeri dell'intestazione, che finora erano scritti a mano nel JSX.
app.post("/api/statistiche", richiedeAccesso, async(req, res)=>{
    const iduser = req.utente.id;
    try{
        const r = await pool.query(
            // Il filtro su m.codice vale per tutti e tre i conteggi: in matches
            // restano le righe di prova precedenti (codice NULL), e i giudizi
            // che le riguardano non devono comparire nei totali degli outfit.
            `SELECT count(*)                                AS totali,
                    count(*) FILTER (WHERE u.responso='si') AS approvati,
                    count(*) FILTER (WHERE u.responso='no') AS rifiutati
             FROM matches m
             LEFT JOIN user_data u ON u.id_match=m.id AND u.id_user=$1
                                  AND u.stato='giudicato'
             WHERE m.codice = ANY($2)`, [iduser, outfits.codici()]);
        const s = r.rows[0];
        res.json({
            totali: +s.totali, approvati: +s.approvati, rifiutati: +s.rifiutati,
            da_revisionare: +s.totali - (+s.approvati) - (+s.rifiutati),
        });
    }catch(errore){
        erroreDb(res, errore);
    }
});

// Scheda completa di un outfit: capi, prezzi, link ai prodotti.
app.get("/api/outfit/:codice", richiedeAccesso, (req, res)=>{
    const o = outfits.perId(req.params.codice);
    if (!o) return res.status(404).json({errore: "outfit non trovato"});
    res.json(o);
});

// Catalogo completo con i filtri già calcolati, per viste diverse dalla
// revisione (griglia, ricerca per brand, fascia di prezzo).
app.get("/api/catalogo", richiedeAccesso, (req, res)=>{
    res.json({
        generato_il: outfits.generatoIl(),
        filtri: outfits.filtri(),
        outfit: outfits.tutti().map(outfits.sintesi),
    });
});

// Rilegge il JSON senza riavviare, dopo una nuova tornata di immagini.
app.post("/api/ricarica", richiedeAccesso, async(req, res)=>{
    try{
        await outfits.carica();
        res.json({ok: true, outfit: outfits.codici().length});
    }catch(e){
        res.status(500).json({errore: e.message});
    }
});

/** Unisce le righe del database ai dati del JSON, nell'ordine del JSON
 *  (che è per compatibilità decrescente: i migliori si revisionano prima). */
function conOutfit(righe) {
    const posizione = new Map(outfits.codici().map((c, i) => [c, i]));
    return righe
        .filter((r) => outfits.perId(r.codice))   // pool rigenerato: codice non più valido
        .sort((a, b) => posizione.get(a.codice) - posizione.get(b.codice))
        .map((r) => ({ id: r.id, ...outfits.sintesi(outfits.perId(r.codice)) }));
}

// Un controllo che non richiede token: Render lo interroga per sapere se il
// servizio è vivo, e non ha modo di autenticarsi.
app.get("/api/salute", (req, res) => res.json({ok: true, outfit: outfits.codici().length}));

avvia().catch((e) => {
    console.error('Avvio fallito —', e.message);
    process.exit(1);
});
