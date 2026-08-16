// Indirizzo dell'API in un posto solo, così cambiare porta o dominio non
// vuol dire cercare "localhost" dentro i componenti. Si imposta in
// mystylist/.env con VITE_API_URL.
export const API = import.meta.env.VITE_API_URL || "http://localhost:3002";

export const leggiToken = () => localStorage.getItem("token");
export const leggiUtente = () => localStorage.getItem("username") || "";
export const salvaSessione = (token, utente) => {
    localStorage.setItem("token", token);
    localStorage.setItem("iduser", utente.id);
    localStorage.setItem("username", utente.username);
    localStorage.setItem("logged", "true");
};
export const chiudiSessione = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("iduser");
    localStorage.removeItem("username");
    localStorage.setItem("logged", "false");
};

export class SessioneScaduta extends Error {}

export async function posta(percorso, corpo) {
    const token = leggiToken();
    const risposta = await fetch(API + percorso, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // Il server ricava l'utente da qui e non dal corpo della
            // richiesta: l'id mandato dal client non è più una credenziale.
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(corpo),
    });

    // Token assente, scaduto o manomesso: la sessione va rifatta, e ha poco
    // senso mostrare l'errore come se fosse un guasto.
    if (risposta.status === 401) {
        chiudiSessione();
        throw new SessioneScaduta("Sessione scaduta: rifai l'accesso.");
    }

    const dati = await risposta.json();
    // Il server risponde {errore: "..."} invece di lasciar morire la richiesta
    // in silenzio: qui diventa un'eccezione che il componente può mostrare.
    if (dati && dati.errore) throw new Error(dati.errore);
    return dati;
}

export async function prendi(percorso) {
    const token = leggiToken();
    const risposta = await fetch(API + percorso, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (risposta.status === 401) {
        chiudiSessione();
        throw new SessioneScaduta("Sessione scaduta: rifai l'accesso.");
    }
    return risposta.json();
}
