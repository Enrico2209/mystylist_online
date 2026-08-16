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

## Tornare indietro

Il collegamento aggiunge una colonna e delle righe, non cancella niente:

```sql
DELETE FROM matches WHERE codice IS NOT NULL;
ALTER TABLE matches DROP COLUMN codice;
ALTER TABLE user_data DROP COLUMN commento, DROP COLUMN motivi;
```
