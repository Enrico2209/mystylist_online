# Collegamento fra la pipeline e la UI

La UI di revisione mostra gli outfit prodotti dalla pipeline in
`nuvolari backend`. Le due parti restano separate:

| dove sta | cosa contiene |
|---|---|
| `nuvolari backend/outfits_ui.json` | outfit, capi, brand, prezzi, link |
| `nuvolari backend/outfit_images/` | le foto generate (1,9 MB l'una) |
| `nuvolari backend/outfit_thumbs/` | le miniature per le liste (8 KB l'una) |
| database Neon | solo chi ha giudicato cosa |

Il ponte fra le due è la colonna `matches.codice`, che contiene l'`outfit_id`
esadecimale del JSON. `matches.id` resta un intero, così `user_data` e i
giudizi già dati non vanno toccati.

## Accesso

Il login rilascia un token firmato (JWT) e ogni endpoint ricava l'utente da
lì. L'`iduser` mandato dal client non è più una credenziale: prima bastava
`{"iduser": 1}` nel corpo della richiesta per leggere e scrivere i giudizi
senza passare dal login.

Le password sono in hash bcrypt. Quelle rimaste in chiaro vengono convertite
da sé al primo accesso riuscito, senza chiedere a nessuno di reimpostarle.

```
node crea_utente.js francesco       # crea, o cambia la password
```

`JWT_SECRET` è obbligatorio: senza, il server non parte, perché i token
sarebbero falsificabili. Per generarne uno:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Avvio

```
npm --prefix server start          # API su http://localhost:3002
npm --prefix mystylist run dev     # UI  su http://localhost:5173
```

La porta 3002 è impostata in `server/.env` (`PORT`) e in `mystylist/.env`
(`VITE_API_URL`): la 3001 su questa macchina è occupata da un altro progetto.
`ASSETS_DIR` in `server/.env` dice dove sta la cartella della pipeline.

## Dopo una nuova tornata di immagini

```
cd "../../nuvolari backend"
python3 build_ui_json.py       # rigenera il JSON con i nuovi outfit
python3 make_thumbs.py         # miniature per le immagini nuove
cd -
node seed_outfits.js           # aggiunge i nuovi outfit a matches
curl -X POST localhost:3002/api/ricarica   # rilegge il JSON senza riavviare
```

`seed_outfits.js` è ripetibile: inserisce solo gli outfit mancanti e non
tocca i giudizi. `node seed_outfits.js --stato` dice come siamo messi senza
scrivere niente.

## Endpoint

| metodo | percorso | a cosa serve |
|---|---|---|
| POST | `/api/login` | `{username, password}` |
| POST | `/api/revisionare` | `{iduser}` — coda, per compatibilità decrescente |
| POST | `/api/giudicato` | `{iduser}` — già revisionati, col responso |
| POST | `/api/giudica` | `{iduser, id_match, responso, commento, motivi}` |
| POST | `/api/statistiche` | `{iduser}` — totali, approvati, rifiutati |
| GET | `/api/outfit/:codice` | scheda completa: capi, prezzi, link |
| GET | `/api/catalogo` | tutti gli outfit + filtri già calcolati |
| POST | `/api/ricarica` | rilegge il JSON dal disco |
| GET | `/media/...` | foto e miniature (solo file immagine) |

`/api/giudica` è ripetibile: rigiudicare lo stesso outfit aggiorna il
responso invece di aggiungere una seconda riga. `responso` è `si` o `no`;
`commento` e `motivi` sono facoltativi.

## Leggere i rifiuti

Rifiutando, la UI chiede perché: voci spuntate in `user_data.motivi`
(`text[]`) e testo libero in `user_data.commento`. Le voci servono a contare,
il testo a capire i casi che le voci non coprono.

```sql
-- i difetti più frequenti, da cui partire per correggere la pipeline
SELECT unnest(motivi) AS motivo, count(*) FROM user_data
WHERE responso='no' GROUP BY 1 ORDER BY 2 DESC;

-- i rifiuti con commento, con il codice dell'outfit per ritrovarlo nel JSON
SELECT m.codice, u.motivi, u.commento FROM user_data u
JOIN matches m ON m.id=u.id_match
WHERE u.responso='no' AND u.commento IS NOT NULL;
```

## Metterlo online

Tre pezzi: il database (Neon, già online), l'API e il frontend su Render, le
foto su object storage. Le foto non stanno su Render: sono 435 MB, e a ogni
tornata di immagini cambierebbero — un CDN le serve meglio e senza rideploy.

**1. Le foto e il JSON** su Cloudflare R2 (gratis fino a 10 GB) o S3:

```
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=...
cd "../../nuvolari backend" && python3 carica_media.py --prova   # cosa caricherebbe
cd "../../nuvolari backend" && python3 carica_media.py
```

Carica solo le immagini generate, le miniature e le foto dei capi che
compaiono negli outfit — non il catalogo intero, che serve alla pipeline.
Poi si dà accesso pubblico in lettura al bucket (R2 → Settings → Public
Development URL, oppure un dominio tuo).

**2. Il repository su GitHub.** Render tira da lì:

```
git remote add origin https://github.com/<tuo-utente>/mystylist.git
git push -u origin main
```

Il `.gitignore` tiene fuori `.env`: la stringa Neon e il segreto dei token
non devono finire nel repository.

**3. Render.** New → Blueprint, si punta al repo: `render.yaml` descrive già
i due servizi. Poi si compilano a mano le variabili marcate `sync: false`:

| variabile | dove |
|---|---|
| `DATABASE_URL` | la stessa stringa Neon che usi in locale |
| `JWT_SECRET` | **nuovo**, non quello di sviluppo |
| `MEDIA_BASE_URL` | l'indirizzo pubblico del bucket |
| `OUTFITS_JSON_URL` | `<bucket>/outfits_ui.json` |
| `CORS_ORIGIN` | l'indirizzo del frontend su Render |
| `VITE_API_URL` | (sul servizio statico) l'indirizzo dell'API |

`CORS_ORIGIN` e `VITE_API_URL` si sanno solo dopo il primo deploy, perché
Render assegna i domini: si mettono al secondo giro e si rilancia.

**Dopo una nuova tornata di immagini**, online non serve un rideploy:

```
python3 carica_media.py                              # le nuove foto
curl -X POST https://<api>/api/ricarica -H "Authorization: Bearer <token>"
```

## Tornare indietro

Il collegamento aggiunge una colonna e delle righe, non cancella niente:

```sql
DELETE FROM matches WHERE codice IS NOT NULL;
ALTER TABLE matches DROP COLUMN codice;
ALTER TABLE user_data DROP COLUMN commento, DROP COLUMN motivi;
```
