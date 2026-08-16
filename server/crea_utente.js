"use strict";

/**
 * Crea uno stilista, o cambia la password di uno esistente.
 *
 * La password si digita al momento e non passa dalla riga di comando: gli
 * argomenti finiscono nella cronologia della shell e nell'elenco dei processi.
 *
 * Uso:
 *     node crea_utente.js francesco
 */

require("dotenv").config();
const readline = require("readline");
const { Pool } = require("pg");
const { cifra } = require("./auth");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

/** Chiede la password senza stamparla a schermo. */
function chiedi(domanda) {
    return new Promise((risolvi) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const scrivi = rl._writeToOutput;
        rl.question(domanda, (risposta) => {
            rl._writeToOutput = scrivi;
            process.stdout.write("\n");
            rl.close();
            risolvi(risposta);
        });
        rl._writeToOutput = () => {};
        process.stdout.write(domanda);
    });
}

async function main() {
    const username = process.argv[2];
    if (!username) {
        console.error("uso: node crea_utente.js <username>");
        process.exit(1);
    }

    const password = await chiedi(`Password per "${username}": `);
    if (password.length < 8) {
        console.error("La password deve avere almeno 8 caratteri.");
        process.exit(1);
    }
    const conferma = await chiedi("Ripetila: ");
    if (password !== conferma) {
        console.error("Le due password non coincidono.");
        process.exit(1);
    }

    const hash = await cifra(password);
    const gia = await pool.query(`SELECT id FROM users WHERE username=$1`, [username]);
    if (gia.rowCount) {
        await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, gia.rows[0].id]);
        console.log(`[OK] password aggiornata per ${username} (id ${gia.rows[0].id})`);
    } else {
        const r = await pool.query(
            `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`,
            [username, hash]);
        console.log(`[OK] utente ${username} creato (id ${r.rows[0].id})`);
    }
    await pool.end();
}

main().catch((e) => {
    console.error("errore:", e.message);
    process.exit(1);
});
