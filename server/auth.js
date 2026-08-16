"use strict";

/**
 * Autenticazione: hash delle password e token di sessione.
 *
 * Prima non c'era niente di tutto questo. Il login confrontava la password in
 * chiaro e non rilasciava nulla; poi ogni endpoint si fidava dell'id utente
 * che gli arrivava nel corpo della richiesta. In locale non cambia niente,
 * online vuol dire che chiunque conosca l'indirizzo può leggere e scrivere i
 * giudizi senza passare dal login — basta mandare {"iduser": 1}.
 *
 * Ora il login rilascia un token firmato e gli endpoint leggono l'utente da
 * lì. L'id nel corpo della richiesta non viene più guardato.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const SEGRETO = process.env.JWT_SECRET;
const DURATA = process.env.JWT_DURATA || "12h";
const COSTO_BCRYPT = 12;

// Senza segreto i token sarebbero falsificabili da chiunque: meglio non
// partire affatto che partire con una sicurezza finta.
if (!SEGRETO) {
    throw new Error(
        "JWT_SECRET non impostato. Mettilo in .env (in locale) o fra le " +
        "variabili d'ambiente del servizio (in produzione). Per generarne " +
        "uno: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
}

const cifra = (password) => bcrypt.hash(password, COSTO_BCRYPT);

/** Le password già in tabella sono in chiaro: finché non sono migrate tutte,
 *  si accetta anche il confronto diretto — ma solo se il valore salvato NON
 *  è un hash, così una password migrata non può più essere aggirata. */
async function verifica(password, salvata) {
    if (typeof salvata !== "string" || salvata.length === 0) return false;
    if (/^\$2[aby]\$/.test(salvata)) return bcrypt.compare(password, salvata);
    // false esplicito, non {daMigrare: false}: un oggetto è sempre truthy, e
    // chi chiama fa "if (!esito)" — così passava anche la password sbagliata.
    return password === salvata ? { daMigrare: true } : false;
}

const emettiToken = (utente) =>
    jwt.sign({ sub: utente.id, username: utente.username }, SEGRETO, { expiresIn: DURATA });

/** Middleware: mette req.utente e blocca chi non ha un token valido. */
function richiedeAccesso(req, res, next) {
    const intestazione = req.get("authorization") || "";
    const token = intestazione.startsWith("Bearer ") ? intestazione.slice(7) : null;
    if (!token) {
        return res.status(401).json({ errore: "Accesso richiesto." });
    }
    try {
        const dati = jwt.verify(token, SEGRETO);
        req.utente = { id: dati.sub, username: dati.username };
        next();
    } catch (e) {
        // scaduto o manomesso: per il client è la stessa cosa, si rifà il login
        res.status(401).json({ errore: "Sessione scaduta: rifai l'accesso." });
    }
}

module.exports = { cifra, verifica, emettiToken, richiedeAccesso };
