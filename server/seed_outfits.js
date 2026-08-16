"use strict";

/**
 * Allinea la tabella matches agli outfit presenti nel JSON.
 *
 * Perché serve una colonna in più: l'outfit_id della pipeline è una stringa
 * esadecimale (8822bccf5f77), mentre matches.id è un intero a cui user_data
 * già rimanda. Cambiare il tipo di matches.id vorrebbe dire toccare anche i
 * giudizi già dati; aggiungere matches.codice no. Quindi il database continua
 * a ragionare per interi, e il codice fa da ponte verso il JSON.
 *
 * Lo script è ripetibile: rilanciarlo dopo una nuova tornata di immagini
 * aggiunge solo gli outfit nuovi e lascia intatti i giudizi.
 *
 * Uso:
 *     node seed_outfits.js            aggiunge i mancanti
 *     node seed_outfits.js --stato    non scrive niente, dice solo come siamo
 */

require("dotenv").config();
const { Pool } = require("pg");
const outfits = require("./outfits");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function main() {
    const soloStato = process.argv.includes("--stato");

    outfits.carica();
    const codici = outfits.codici();
    console.log(`JSON: ${codici.length} outfit con immagine generata`);

    if (!soloStato) {
        await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS codice text`);
        await pool.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS matches_codice_unico ON matches (codice)`);
        // Il motivo del rifiuto: i motivi spuntati (per contarli) e il testo
        // libero (per capire i casi che le voci fisse non coprono).
        await pool.query(`ALTER TABLE user_data ADD COLUMN IF NOT EXISTS commento text`);
        await pool.query(`ALTER TABLE user_data ADD COLUMN IF NOT EXISTS motivi text[]`);
    }

    const esistenti = await pool.query(
        `SELECT codice FROM matches WHERE codice IS NOT NULL`);
    const gia = new Set(esistenti.rows.map((r) => r.codice));
    const mancanti = codici.filter((c) => !gia.has(c));

    console.log(`database: ${gia.size} outfit già presenti, ${mancanti.length} da inserire`);

    // Codici nel database che il JSON non conosce più: succede se la pipeline
    // rigenera il pool e gli outfit cambiano id. Non li cancello — i giudizi
    // che li riguardano restano validi come storico — ma vanno segnalati.
    const orfani = [...gia].filter((c) => !codici.includes(c));
    if (orfani.length) {
        console.log(`attenzione: ${orfani.length} codici nel database non sono più nel JSON ` +
                    `(pool rigenerato); restano come storico ma non compaiono in revisione`);
    }

    if (soloStato) {
        await pool.end();
        return;
    }

    // matches.id è una colonna identity: l'ordine di inserimento diventa
    // l'ordine degli id, e il JSON è già ordinato per compatibilità.
    let inseriti = 0;
    for (const codice of mancanti) {
        const r = await pool.query(
            `INSERT INTO matches (codice) VALUES ($1) ON CONFLICT (codice) DO NOTHING`,
            [codice]);
        inseriti += r.rowCount;
    }

    console.log(`[OK] inseriti ${inseriti} outfit in matches`);
    await pool.end();
}

main().catch((e) => {
    console.error("errore:", e.message);
    process.exit(1);
});
